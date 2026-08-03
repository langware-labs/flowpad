import { useEffect, useRef, useState } from 'react';
import { isReadyForInput, PrefKey, WorkerMode, type AgenticProcess } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { usePreferenceResolved } from '@src/hooks/use-preference';
import { useViewMode, viewModePtyMode, ViewMode } from '@src/contexts/view-mode-context';
import { notify } from '@src/notifications/notify';

interface UseProcessSurfaceOptions {
  process?: AgenticProcess | null;
  /** Live xterm dimensions for the →terminal direction, when a terminal is
   *  mounted. Ref-free so this hook stays testable and has no opinion about who
   *  owns the terminal; omitted in vibe, where the backend picks defaults. */
  getDims?: () => { cols: number; rows: number } | undefined;
  /** Whether a lifecycle mutation may start now. The always-mounted panel
   *  keeps this false while its own `/open` is in flight: mode changes remain
   *  pending in `lastReconciledMode`, then reconcile when startup is ready. */
  canSwitch?: boolean;
  /** Subscribe to the process inside this hook. Disable this when the owning
   *  component already received `process` from `useEntity`: the same object is
   *  then both the reactive render source and the lifecycle mutation target. */
  subscribeToProcess?: boolean;
}

/**
 * The mode each process was last RECONCILED to, keyed by process id and held at
 * module scope on purpose.
 *
 * Switching vibe⇄terminal swaps which component is on screen — `flow-page`
 * renders `VibeWorkspace` or `ContentPanel`, never both — so the outgoing mount
 * unmounts in the same commit the incoming one mounts. A per-mount ref would
 * lose the previous mode exactly there, making the one transition that needs
 * reconciling the one silently skipped. Keyed by process so two sessions can't
 * shadow each other.
 */
const lastReconciledMode = new Map<string, ViewMode>();

/** Test seam: forget what each process was reconciled to. */
export function resetSurfaceReconcileState(): void {
  lastReconciledMode.clear();
}

/**
 * Keep one process's TRANSPORT aligned with the view mode — the whole of what a
 * session needs beyond rendering, now that the footer `ViewToggle` is the single
 * mode selector.
 *
 * Mode selection itself is pure navigation (`?viewMode=`, adopted as the
 * preference on load). The one thing navigation cannot express is the transport,
 * because that is a worker lifecycle action: the terminal surface is an
 * interactive PTY, vibe and chat are headless print-mode. Mount this wherever a
 * session is on screen and the reconcile happens however the mode changed — the
 * footer toggle, a `?viewMode=` URL, or `window.setView()`.
 *
 * Reconciles on a mode CHANGE only, never on first sight of a process: merely
 * opening a session must not kill or spawn a worker. By default it returns the
 * reactive entity it subscribes to; an existing `useEntity` owner can disable
 * that subscription and receive its own process back unchanged.
 */
export function useProcessSurface({
  process,
  getDims,
  canSwitch = true,
  subscribeToProcess = true,
}: UseProcessSurfaceOptions): AgenticProcess | null {
  const viewMode = useViewMode();
  // The preference may not have been read in yet (first load in a browser
  // profile, no localStorage boot seed). `useViewMode` serves the registry
  // default meanwhile, and recording THAT as the process's last mode would make
  // the real value look like a user-driven change when it lands — spawning or
  // killing a worker purely because a preference resolved late.
  const modeResolved = usePreferenceResolved(PrefKey.VIEW_MODE);
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null, {
    enabled: subscribeToProcess,
  });
  const live = liveProcess ?? process ?? null;
  const ptyMode = !(live?.isHeadless ?? false);
  const awaitingUserInput = isReadyForInput(live ?? {});
  // Guards re-entry with the CURRENT value rather than a closed-over one, and
  // keeps a transport switch from re-rendering every mounted session twice.
  const switching = useRef(false);
  // A URL mode can change while the previous lifecycle promise is still in
  // flight. Ref completion alone does not re-run an effect that returned on
  // `switching.current`; this revision drains the latest desired mode after a
  // successful switch without immediately retrying failures.
  const [reconcileRevision, setReconcileRevision] = useState(0);

  useEffect(() => {
    if (!modeResolved || !live || switching.current) return;
    const key = live.id;
    const previous = lastReconciledMode.get(key);
    if (previous === undefined) {
      lastReconciledMode.set(key, viewMode); // first sight — record, never act
      return;
    }
    if (previous === viewMode) return;

    const wantPty = viewModePtyMode(viewMode);
    if (wantPty === ptyMode) {
      lastReconciledMode.set(key, viewMode); // transport already matches
      return;
    }
    // Keep `previous` unchanged while the owning panel finishes its startup
    // mutation. A URL mode selected during that window is then still a real
    // previous→current transition when readiness flips true.
    if (!canSwitch) return;
    // The backend 409s a mid-turn switch. Deliberately do NOT record the mode
    // here: leaving it unrecorded means this effect retries the moment the
    // worker goes idle, instead of stranding the session on the wrong transport.
    if (!awaitingUserInput) return;

    switching.current = true;
    void (async () => {
      let reconciled = false;
      try {
        await live.switchMode(wantPty ? WorkerMode.Interactive : WorkerMode.CLI, wantPty ? getDims?.() : undefined);
        lastReconciledMode.set(key, viewMode);
        reconciled = true;
        // The transcript reconcile pulls in turns the other mode produced. It is
        // a VIEW concern and slow on a large session (backend transcript parse),
        // so it is never awaited — holding on it wedged rapid switching.
        // `loadHistory({ force: true })` REPLACES the stream with the transcript
        // (clears internally); the live WS stream keeps the pane current.
        void live
          .loadHistory({ force: true })
          .catch((err) => console.debug('[sessionSurface] post-switch reconcile deferred:', err));
      } catch (err) {
        console.error('[sessionSurface] mode switch failed', err);
        notify.error({
          title: wantPty ? 'Could not switch to terminal' : 'Could not switch to chat',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        switching.current = false;
        if (reconciled) setReconcileRevision((revision) => revision + 1);
      }
    })();
  }, [viewMode, live, ptyMode, awaitingUserInput, modeResolved, getDims, canSwitch, reconcileRevision]);

  return live;
}
