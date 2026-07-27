import { useCallback, useState } from 'react';
import { isReadyForInput, WorkerMode, type AgenticProcess } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';

/** The two TRANSPORT modes of one agentic session. */
export type TransportMode = 'chat' | 'terminal';

/** The three ways a session can be shown. `vibe` is a view mode, not a transport. */
export type SessionMode = TransportMode | 'vibe';

interface UseProcessModeSwitchOptions {
  process?: AgenticProcess | null;
  /** Live xterm dimensions for the →terminal direction, when a terminal is
   *  mounted. Ref-free so this hook stays testable and has no opinion about who
   *  owns the terminal; omitted in vibe, where the backend picks defaults. */
  getDims?: () => { cols: number; rows: number } | undefined;
}

export interface ProcessModeSwitch {
  /** The transport the session is actually on (`pty_mode`), reactively. */
  transport: TransportMode;
  /** `isReadyForInput` — the backend 409s a mid-turn transport switch. */
  awaitingUserInput: boolean;
  /** A transport switch is in flight. */
  switching: boolean;
  /** Pick a mode. URL-first: this navigates; the URL load applies the mode. */
  select: (mode: SessionMode) => void;
}

/**
 * The session mode switch — chat ⇄ terminal ⇄ vibe — for one agentic process.
 * One definition of "what picking a mode means", shared by every mount of
 * `TerminalModeSwitch` (the terminal header and the vibe display strip).
 *
 * **Every pick is URL-first.** The handler only navigates: `?chatMode=<mode>`
 * for the two renderers, `?viewMode=vibe` for vibe. The mounted URL is then the
 * single writer — `useDockChatModeOverrideSync` / `useDockViewModeOverrideSync`
 * pin the mode and adopt it as the preference. Nothing here writes a pref.
 *
 * The one thing navigation cannot do is move the TRANSPORT, because that is a
 * worker lifecycle action, not a view: chat = headless print-mode (no PTY),
 * terminal = interactive PTY. So when — and only when — the pick disagrees with
 * `pty_mode`, this also runs the standardized `switchMode(WorkerMode.CLI|
 * Interactive)`: →terminal spawns + resumes the PTY; →chat kills the PTY worker,
 * keeping `session_id` and the transcript, and reverts to headless routing. Both
 * reconcile the transcript so the destination shows turns the other mode
 * produced. The backend 409s a mid-turn switch; `switching` guards against
 * double-trigger and drives the spinner.
 *
 * Call this ONCE per mount — a second call site would own a second, disagreeing
 * `switching` state.
 */
export function useProcessModeSwitch({ process, getDims }: UseProcessModeSwitchOptions): ProcessModeSwitch {
  const [switching, setSwitching] = useState(false);
  const { currentDock, navigation } = useDockNavigation();
  // The reactive entity: `pty_mode` and the worker status both move underneath
  // us mid-session, and the switch's selection + gate must follow.
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null);
  const live = liveProcess ?? process ?? null;
  const transport: TransportMode = live?.pty_mode === false ? 'chat' : 'terminal';
  const awaitingUserInput = isReadyForInput(live ?? {});

  const select = useCallback(
    (mode: SessionMode) => {
      if (!currentDock) return;

      // Vibe: a view mode of this same dock, reusing the Discuss affordance —
      // "continue this conversation in vibe mode". Pure navigation, no transport
      // work, so it is never gated on the worker being idle.
      if (mode === 'vibe') {
        navigation.openDock(currentDock.withViewMode(ViewMode.Vibe));
        return;
      }

      // Leaving vibe for a renderer: drop the vibe view mode as the footer
      // ViewToggle does — Standard is where its Vibe⇄Standard pair lands, and
      // the chatMode below out-ranks Standard's default skin either way.
      const dock = currentDock.withChatMode(mode).withViewMode(
        currentDock.viewMode === ViewMode.Vibe ? ViewMode.Standard : currentDock.viewMode,
      );
      navigation.openDock(dock);

      // …and the part the URL can't express: move the worker if the pick
      // disagrees with the live transport. Keyed on `pty_mode` (held stable by
      // the SDK desired-value latch) and NOT on the chat skin, whose preference
      // lags under rapid switching — a skin-keyed test could short-circuit a
      // direction that has not actually landed.
      if (!process || switching || transport === mode) return;
      if (!awaitingUserInput) return; // mirrors the control's disabled gate

      const toChat = mode === 'chat';
      setSwitching(true);
      void (async () => {
        try {
          if (toChat) await process.switchMode(WorkerMode.CLI);
          else await process.switchMode(WorkerMode.Interactive, getDims?.());
        } catch (err) {
          console.error('[useProcessModeSwitch] mode switch failed', err);
          notify.error({
            title: toChat ? 'Could not switch to chat' : 'Could not switch to terminal',
            message: err instanceof Error ? err.message : String(err),
          });
          setSwitching(false);
          return;
        }
        // The TRANSPORT switch is done — re-enable the control now. The transcript
        // reconcile (pull in turns the other mode produced) is a VIEW concern and is
        // slow on a large session (the backend transcript parse), so DON'T hold the
        // control disabled behind it — that wedged rapid switching. Reconcile in the
        // background; the chat pane fills in when it resolves (and the live WS stream
        // keeps it current meanwhile). `loadHistory({ force: true })` REPLACES the
        // stream with the transcript (clears internally) — no separate clear needed.
        setSwitching(false);
        void process
          .loadHistory({ force: true })
          .catch((err) => console.debug('[useProcessModeSwitch] post-switch reconcile deferred:', err));
      })();
    },
    [process, switching, awaitingUserInput, transport, getDims, currentDock, navigation],
  );

  return { transport, awaitingUserInput, switching, select };
}
