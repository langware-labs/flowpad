import { useCallback, useState } from 'react';
import { WorkerMode, type AgenticProcess } from '@sdk';
import { setChatUiOverride } from '@src/contexts/chat-ui-mode-context';
import { notify } from '@src/notifications/notify';

/** The two TRANSPORT modes of one agentic session (vibe is a skin, not a
 *  transport — it rides the same process, see TerminalModeSwitch). */
export type TransportMode = 'chat' | 'terminal';

interface UseProcessModeSwitchOptions {
  process?: AgenticProcess;
  /** `isReadyForInput(process)` — the backend 409s a mid-turn switch. */
  awaitingUserInput: boolean;
  /** Live xterm dimensions for the →terminal direction; ref-free so this hook
   *  stays testable and has no opinion about who owns the terminal. */
  getDims: () => { cols: number; rows: number } | undefined;
}

/**
 * Chat ⇄ Terminal mode switch (mutually-exclusive execution modes of ONE
 * session). Chat = headless print-mode (no PTY); Terminal = interactive PTY.
 * This is a real lifecycle action, not a view flip — one standardized
 * `switchMode(WorkerMode.Interactive|CLI)`: →terminal spawns + resumes the PTY;
 * →chat kills the PTY worker, keeping the session, and reverts to headless
 * routing. Both reconcile the transcript (clear + force-reload) so the
 * destination view shows turns the other mode produced. The backend 409s a
 * mid-turn switch; `switching` guards against double-trigger + drives the
 * spinner.
 *
 * Call this ONCE per terminal (in InteractiveTerminal, which owns the xterm ref
 * and the readiness signal) — a second call site would own a second, disagreeing
 * `switching` state.
 */
export function useProcessModeSwitch({ process, awaitingUserInput, getDims }: UseProcessModeSwitchOptions): {
  switching: boolean;
  switchTo: (target: TransportMode) => Promise<void>;
} {
  const [switching, setSwitching] = useState(false);

  const switchTo = useCallback(
    async (target: TransportMode) => {
      // Mirror the control's disabled gate: never attempt a switch mid-turn (the
      // backend 409s it). The segments are disabled in that state; this is the
      // belt-and-suspenders guard for any non-click caller.
      if (!process || switching || !awaitingUserInput) return;
      const toChat = target === 'chat';
      // Transport already at the target → this pick is a pure SKIN flip, with no
      // lifecycle action to run. That is the common case, not an edge one: in
      // Standard view the chat pane is painted over a perfectly live PTY, so
      // picking `terminal` there means "show me the xterm", not "spawn a PTY".
      // Write the override and stop — never swallow the user's pick.
      //
      // The guard keys on the TRANSPORT (`pty_mode`, held stable by the SDK
      // desired-value latch), NOT on the chat skin: `chatUiOverride` has a known
      // re-render lag under rapid switching, so a skin-keyed guard could
      // early-return on a direction that has not actually landed yet.
      if (process.isHeadless === toChat) {
        setChatUiOverride(target);
        return;
      }
      setSwitching(true);
      try {
        if (toChat) {
          await process.switchMode(WorkerMode.CLI);
          setChatUiOverride('chat');
        } else {
          await process.switchMode(WorkerMode.Interactive, getDims());
          setChatUiOverride('terminal');
        }
      } catch (err) {
        console.error('[InteractiveTerminal] mode switch failed', err);
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
        .catch((err) => console.debug('[InteractiveTerminal] post-switch reconcile deferred:', err));
    },
    [process, switching, awaitingUserInput, getDims],
  );

  return { switching, switchTo };
}
