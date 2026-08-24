import { t } from '@lingui/core/macro';
import { useEffect, useRef, useState } from 'react';
import { isBusy, isReadyForInput, PrefKey, WorkerMode, type AgenticProcess } from '@sdk';
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
 * because that is a worker lifecycle action. Mount this wherever a session is on
 * screen and the reconcile happens however the mode changed — the footer toggle,
 * a `?viewMode=` URL, or `window.setView()`.
 *
 * Reconciliation is ONE-DIRECTIONAL: **a terminal surface requires a PTY; chat
 * and vibe require nothing.** They render the session's stream, which is
 * transport-independent — `SimpleChatPane` binds to `flowDataStream`, a composer
 * send routes to PTY stdin through `_run_pty_prompt`, and a turn this client did
 * not start arrives via `useObservedTurn`. Killing a healthy worker to enter chat
 * bought nothing, and when the backend refused it mid-turn (409) the kill was
 * silently queued to fire minutes later.
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
  // NOT `!awaitingUserInput`: the two are not complements. Readiness also
  // demands a LIVE worker, so a PTY session the user ended (`/exit` -> STOPPED)
  // is neither busy nor ready. Guarding the transcript reload on readiness
  // therefore skipped exactly the session whose turns can only be recovered
  // from disk. `busy` alone asks the one question that branch cares about.
  const turnInFlight = isBusy(live ?? {});
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
    // Chat / vibe need no transport of their own — they render the session's
    // stream, so we never spawn or kill a worker for them (the one-directional
    // rule in this hook's doc comment). They DO need the TRANSCRIPT, though.
    // A turn produced on the surface we are leaving never entered this client's
    // `flowDataStream`: one typed into the xterm has no `prompt()` response
    // stream carrying it here, and `useObservedTurn` only runs while a pane is
    // mounted and the turn is live. The incoming pane's mount-time
    // `loadHistory()` cannot repair that — it is a no-op once `_historyLoaded`
    // is set, and nothing ever resets that latch. So without a forced reload
    // the pane renders a list frozen at the last row it happened to see, until
    // a full page reload (FLOWPAD-2013). Reconcile the same way the PTY branch
    // below already does.
    if (!wantPty) {
      // A forced reload REPLACES the stream with the on-disk transcript, so a
      // frame not yet persisted would be dropped — only ever do it once the
      // turn is over, matching `loadHistory`'s documented force-path contract.
      // The mode is deliberately left unrecorded while a turn is in flight so
      // this effect retries the moment the worker goes idle rather than
      // skipping the reconcile outright (same reasoning as the mid-turn guard
      // below). Gated on `busy`, NOT readiness — see `turnInFlight` above: a
      // session ended from the xterm (`/exit`) is not ready, and gating on
      // readiness stranded its last turns off the vibe pane for good.
      if (turnInFlight) return;
      lastReconciledMode.set(key, viewMode);
      void live
        .loadHistory({ force: true })
        .catch((err) => console.debug('[sessionSurface] surface reconcile deferred:', err));
      return;
    }
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
        // Only ever the PTY direction now — chat/vibe returned above.
        await live.switchMode(WorkerMode.Interactive, getDims?.());
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
          title: t`Could not switch to terminal`,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        switching.current = false;
        if (reconciled) setReconcileRevision((revision) => revision + 1);
      }
    })();
  }, [viewMode, live, ptyMode, awaitingUserInput, turnInFlight, modeResolved, getDims, canSwitch, reconcileRevision]);

  return live;
}
