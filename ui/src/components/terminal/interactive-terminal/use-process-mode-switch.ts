import { useCallback, useState } from 'react';
import { isReadyForInput, WorkerMode, type AgenticProcess } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { previousNonVibeViewMode, useIsVibe, ViewMode } from '@src/contexts/view-mode-context';
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
  /** The reactive entity this hook already subscribes to — exposed so a caller
   *  doesn't open a second subscription to the same process. */
  live: AgenticProcess | null;
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
  const { navigation } = useDockNavigation();
  const isVibe = useIsVibe();
  // The reactive entity: `pty_mode` and the worker status both move underneath
  // us mid-session, and the switch's selection + gate must follow.
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null);
  const live = liveProcess ?? process ?? null;
  const transport: TransportMode = live?.pty_mode === false ? 'chat' : 'terminal';
  const awaitingUserInput = isReadyForInput(live ?? {});

  const select = useCallback(
    (mode: SessionMode) => {
      if (!process) return;

      // Address the PROCESS, never the ambient dock. This hook is mounted in the
      // vibe display strip too, where `currentDock` is often a CHILD tab (an
      // asset editor opened from inside the workspace) — stamping the mode onto
      // that URL would navigate the user to the child in the new mode instead of
      // to their session. `openShellProcess` is the one place that knows how to
      // build a process URL, and every other open-in-vibe call site uses it.
      //
      // Vibe is a view mode of that URL; chat/terminal is the renderer one level
      // down. Leaving vibe restores the mode in use before it — entering vibe
      // overwrote the persisted preference, so inheriting would pin the user in
      // vibe and hardcoding Standard would quietly demote an Advanced user.
      void navigation.openShellProcess(
        process.id,
        mode === 'vibe'
          ? { viewMode: ViewMode.Vibe }
          : { chatMode: mode, ...(isVibe ? { viewMode: previousNonVibeViewMode() } : {}) },
      );

      // …and the part the URL can't express: move the worker when the pick
      // disagrees with the live transport. Keyed on `pty_mode` (held stable by
      // the SDK desired-value latch) and NOT on the chat skin, whose preference
      // lags under rapid switching — a skin-keyed test could short-circuit a
      // direction that has not actually landed. `awaitingUserInput` mirrors the
      // control's own disabled gate (the backend 409s a mid-turn switch).
      if (mode === 'vibe' || switching || transport === mode || !awaitingUserInput) return;

      const toChat = mode === 'chat';
      setSwitching(true);
      void (async () => {
        try {
          await process.switchMode(toChat ? WorkerMode.CLI : WorkerMode.Interactive, toChat ? undefined : getDims?.());
          // The transcript reconcile pulls in turns the other mode produced. It
          // is a VIEW concern and slow on a large session (backend transcript
          // parse), so it is never awaited — holding the control behind it
          // wedged rapid switching. `loadHistory({ force: true })` REPLACES the
          // stream with the transcript (clears internally); the live WS stream
          // keeps the pane current meanwhile.
          void process
            .loadHistory({ force: true })
            .catch((err) => console.debug('[useProcessModeSwitch] post-switch reconcile deferred:', err));
        } catch (err) {
          console.error('[useProcessModeSwitch] mode switch failed', err);
          notify.error({
            title: toChat ? 'Could not switch to chat' : 'Could not switch to terminal',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setSwitching(false);
        }
      })();
    },
    [process, switching, awaitingUserInput, transport, getDims, isVibe, navigation],
  );

  return { live, transport, awaitingUserInput, switching, select };
}
