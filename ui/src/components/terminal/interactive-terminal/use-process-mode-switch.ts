import { useCallback, useEffect, useRef, useState } from 'react';
import { isReadyForInput, WorkerMode, type AgenticProcess } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useViewMode, viewModePtyMode, ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';

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
  /** Whether the session is actually on a PTY (`pty_mode`), reactively. */
  ptyMode: boolean;
  /** `isReadyForInput` — the backend 409s a mid-turn transport switch. */
  awaitingUserInput: boolean;
  /** A transport switch is in flight. */
  switching: boolean;
  /** Pick a mode. URL-first: this navigates; the URL load applies and adopts it. */
  select: (mode: ViewMode) => void;
}

/**
 * The session mode switch for one agentic process — the in-context twin of the
 * footer `ViewToggle`, writing the same single preference (view mode).
 *
 * **Picking a mode only navigates** (`?viewMode=`); the mounted URL is the single
 * writer, adopting the mode as the preference (`useDockViewModeOverrideSync`).
 *
 * The one thing navigation cannot express is the TRANSPORT, because that is a
 * worker lifecycle action rather than a view: the terminal surface is an
 * interactive PTY, vibe and chat are headless print-mode. That reconcile lives in
 * an effect (`useSessionSurfaceReconcile`) rather than in this click handler, so
 * it happens however the mode changed — from here, from the footer toggle, or
 * from `window.setView()`.
 *
 * Call this ONCE per mount — a second call site would own a second, disagreeing
 * `switching` state.
 */
export function useProcessModeSwitch({ process, getDims }: UseProcessModeSwitchOptions): ProcessModeSwitch {
  const { navigation, currentDock } = useDockNavigation();
  const viewMode = useViewMode();
  // The reactive entity: `pty_mode` and the worker status both move underneath
  // us mid-session, and the switch's selection + gate must follow.
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null);
  const live = liveProcess ?? process ?? null;
  const ptyMode = live?.pty_mode !== false;
  const awaitingUserInput = isReadyForInput(live ?? {});
  const { switching } = useSessionSurfaceReconcile({ process: live, viewMode, ptyMode, awaitingUserInput, getDims });

  const select = useCallback(
    (mode: ViewMode) => {
      // Address the PROCESS, never the ambient dock. This hook is mounted in the
      // vibe display strip too, where `currentDock` is often a CHILD tab (an
      // asset editor opened from inside the workspace) — stamping the mode onto
      // that URL would navigate the user to the child in the new mode instead of
      // to their session. `openShellProcess` is the one place that knows how to
      // build a process URL.
      if (process) void navigation.openShellProcess(process.id, { viewMode: mode });
      else if (currentDock) navigation.openDock(currentDock.withViewMode(mode));
    },
    [process, navigation, currentDock],
  );

  return { live, ptyMode, awaitingUserInput, switching, select };
}

/**
 * Align a session's TRANSPORT with the view mode's surface: terminal ⇒ an
 * interactive PTY, vibe/chat ⇒ headless print-mode. One standardized
 * `switchMode(WorkerMode.Interactive|CLI)` — →terminal spawns + resumes the PTY,
 * →headless kills the PTY worker while keeping `session_id` and the transcript.
 * Both then reconcile the transcript so the destination shows turns the other
 * mode produced.
 *
 * Deliberately reconciles on mode CHANGE only, never on mount: merely opening a
 * session must not kill or spawn workers, or every navigation to an old process
 * URL would churn one. The first observed mode is recorded, not acted on.
 */
function useSessionSurfaceReconcile({
  process,
  viewMode,
  ptyMode,
  awaitingUserInput,
  getDims,
}: {
  process: AgenticProcess | null;
  viewMode: ViewMode;
  ptyMode: boolean;
  awaitingUserInput: boolean;
  getDims?: () => { cols: number; rows: number } | undefined;
}): { switching: boolean } {
  const [switching, setSwitching] = useState(false);
  const lastMode = useRef<ViewMode | null>(null);

  useEffect(() => {
    const previous = lastMode.current;
    lastMode.current = viewMode;
    if (previous === null || previous === viewMode) return; // mount, or no change
    if (!process || switching) return;
    const wantPty = viewModePtyMode(viewMode);
    if (wantPty === ptyMode) return; // transport already matches the surface
    if (!awaitingUserInput) return; // the backend 409s a mid-turn switch

    setSwitching(true);
    void (async () => {
      try {
        await process.switchMode(wantPty ? WorkerMode.Interactive : WorkerMode.CLI, wantPty ? getDims?.() : undefined);
        // The transcript reconcile pulls in turns the other mode produced. It is
        // a VIEW concern and slow on a large session (backend transcript parse),
        // so it is never awaited — holding the control behind it wedged rapid
        // switching. `loadHistory({ force: true })` REPLACES the stream with the
        // transcript (clears internally); the live WS stream keeps the pane
        // current meanwhile.
        void process
          .loadHistory({ force: true })
          .catch((err) => console.debug('[sessionSurface] post-switch reconcile deferred:', err));
      } catch (err) {
        console.error('[sessionSurface] mode switch failed', err);
        notify.error({
          title: wantPty ? 'Could not switch to terminal' : 'Could not switch to chat',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSwitching(false);
      }
    })();
  }, [viewMode, process, ptyMode, awaitingUserInput, switching, getDims]);

  return { switching };
}
