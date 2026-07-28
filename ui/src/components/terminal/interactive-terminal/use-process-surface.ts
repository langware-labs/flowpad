import { useEffect, useRef, useState } from 'react';
import { isReadyForInput, WorkerMode, type AgenticProcess } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useViewMode, viewModePtyMode, ViewMode } from '@src/contexts/view-mode-context';
import { notify } from '@src/notifications/notify';

interface UseProcessSurfaceOptions {
  process?: AgenticProcess | null;
  /** Live xterm dimensions for the →terminal direction, when a terminal is
   *  mounted. Ref-free so this hook stays testable and has no opinion about who
   *  owns the terminal; omitted in vibe, where the backend picks defaults. */
  getDims?: () => { cols: number; rows: number } | undefined;
}

/**
 * Keep one process's transport aligned with the view mode — the whole of what a
 * session needs beyond rendering, now that the footer `ViewToggle` is the single
 * mode selector.
 *
 * Mode selection itself is pure navigation (`?viewMode=`, adopted as the
 * preference on load). The one thing navigation cannot express is the TRANSPORT,
 * because that is a worker lifecycle action: the terminal surface is an
 * interactive PTY, vibe and chat are headless print-mode. Mount this wherever a
 * session is on screen and the reconcile happens however the mode changed.
 *
 * Returns the reactive entity it already subscribes to, so callers don't open a
 * second subscription to the same process.
 */
export function useProcessSurface({ process, getDims }: UseProcessSurfaceOptions): {
  live: AgenticProcess | null;
  switching: boolean;
} {
  const viewMode = useViewMode();
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null);
  const live = liveProcess ?? process ?? null;
  const { switching } = useSessionSurfaceReconcile({
    process: live,
    viewMode,
    ptyMode: live?.pty_mode !== false,
    awaitingUserInput: isReadyForInput(live ?? {}),
    getDims,
  });
  return { live, switching };
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
