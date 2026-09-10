import { t } from '@lingui/core/macro';
import { useEffect, useRef, useState } from 'react';
import { isBusy, PrefKey, WorkerMode, type AgenticProcess } from '@sdk';
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

/** The backend action a transport change lands on. The two directions do NOT
 *  share a route, and they do not share a guard either — see the gate below. */
export type TransportRoute = 'open' | 'switch-mode';

/** What a mode selection would have to do to a session's transport, and whether
 *  the server would accept it right now. */
export interface SurfaceTransportGate {
  /** The mode implies a transport change (a worker spawn or a PTY kill). */
  needsSwitch: boolean;
  /** Which backend action that change is issued against, or null for no-op. */
  route: TransportRoute | null;
  /** …and that route refuses it right now. */
  blocked: boolean;
}

/**
 * ONE predicate for "can this session change transport now", read by both the
 * reconcile effect below and the footer `ViewToggle`'s greyed-out state, so the
 * control cannot offer a switch the effect would refuse. It mirrors the SERVER
 * per route: `→CLI` is `switch-mode`, which 409s while `is_turn_busy`; `→PTY` is
 * `start()`/`open`, which has no mid-turn guard, so neither has the client.
 * Hence BUSY, not readiness — readiness is also false for a FAILED session and a
 * `/exit`-ed PTY, the two states whose recovery needs these very clicks.
 * Rules: docs/breadcrumbs/surface_transcript_reconcile.md
 */
export function surfaceTransportGate(
  process: AgenticProcess | null | undefined,
  viewMode: ViewMode,
): SurfaceTransportGate {
  if (!process) return { needsSwitch: false, route: null, blocked: false };
  const wantPty = viewModePtyMode(viewMode);
  const ptyMode = !(process.isHeadless ?? false);
  if (wantPty === ptyMode) return { needsSwitch: false, route: null, blocked: false };
  const route: TransportRoute = wantPty ? 'open' : 'switch-mode';
  return { needsSwitch: true, route, blocked: route === 'switch-mode' && isBusy(process) };
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
 * Reconciliation is BIDIRECTIONAL: **the surface owns the transport in both
 * directions** — a terminal surface requires a PTY, and chat/vibe require the
 * headless one. Chat and vibe can *render* either (`SimpleChatPane` binds to
 * `flowDataStream`, a composer send routes to PTY stdin through
 * `_run_pty_prompt`, and a turn this client did not start arrives via
 * `useObservedTurn`), but `pty_mode` is the session's DURABLE transport intent,
 * and leaving it true after the user walked out of the terminal made it a
 * one-way latch: nothing in `ui/src` ever wrote it back, not even a reload, so
 * a session that had once visited a terminal stayed on a PTY forever
 * (FLOWPAD-2105). Chat and vibe now switch it back to `WorkerMode.CLI`.
 *
 * The reason it was made one-directional in `bf9b51706` was a kill that fired
 * on a HEALTHY worker at the wrong moment — a mid-turn switch the backend 409s,
 * queued to land minutes later. That is a GUARD problem, and the guard is
 * `surfaceTransportGate` above: the `switch-mode` route is declined while
 * `busy`, keyed on the same `is_turn_busy` predicate the backend 409s on, so
 * the two can never disagree. The footer toggle greys its segment on that same
 * call, so the control cannot offer a switch this effect would refuse — and,
 * equally, cannot refuse one the server would have honoured.
 *
 * Reconciles on a mode CHANGE only, never on first sight of a process: merely
 * opening a session must not kill or spawn a worker. The one exception is the
 * transport a terminal surface cannot do without: a chat-born (headless)
 * session opened straight into a terminal mode (`?viewMode=advanced`) gets its
 * PTY on first sight. `InteractiveTerminal` renders by transport (`isHeadless`
 * → SimpleChatPane) and nothing else on the load path supplies one, so without
 * this the footer says Terminal while the pane shows chat until the user
 * toggles modes by hand. There is deliberately NO mirror of that exception:
 * first sight of a PTY-backed session in chat leaves the worker alone, because
 * "the mode this dock opened in" is not a statement that the user left the
 * terminal — and with the round trip restored, a session the user actually did
 * leave already carries `pty_mode=false` when it is next opened.
 *
 * By default it returns the reactive entity it subscribes to; an existing
 * `useEntity` owner can disable that subscription and receive its own process
 * back unchanged.
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
  // `busy`, NOT `!isReadyForInput` — they are not complements (a FAILED session
  // and an `/exit`-ed PTY are neither); see `surfaceTransportGate`. Read here so
  // the effect RE-RUNS when it flips, which is what retries a decline at idle.
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
    const wantPty = viewModePtyMode(viewMode);
    // First sight records the mode and never acts — except a terminal mode on
    // a PTY-less process (see the doc comment), which falls through to the
    // switch below. That path records only once the switch happened, so a
    // startup `canSwitch=false` still retries instead of stranding the session.
    if (previous === undefined && !(wantPty && !ptyMode)) {
      lastReconciledMode.set(key, viewMode);
      return;
    }
    if (previous === viewMode) return;

    if (wantPty === ptyMode) {
      // The transport already matches, so there is no worker lifecycle to run.
      // Chat / vibe still owe the TRANSCRIPT, though. A turn produced on the
      // surface we are leaving never entered this client's `flowDataStream`:
      // one typed into the xterm has no `prompt()` response stream carrying it
      // here, and `useObservedTurn` only runs while a pane is mounted and the
      // turn is live. The incoming pane's mount-time `loadHistory()` cannot
      // repair that — it is a no-op once `_historyLoaded` is set, and nothing
      // ever resets that latch. So without a forced reload the pane renders a
      // list frozen at the last row it happened to see, until a full page
      // reload (FLOWPAD-2013). The switch path below reconciles the same way.
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
        void live
          .loadHistory({ force: true })
          .catch((err) => console.debug('[sessionSurface] surface reconcile deferred:', err));
      }
      lastReconciledMode.set(key, viewMode);
      return;
    }
    // Keep `previous` unchanged while the owning panel finishes its startup
    // mutation. A URL mode selected during that window is then still a real
    // previous→current transition when readiness flips true.
    if (!canSwitch) return;
    // The backend 409s a mid-turn switch in BOTH directions. Deliberately do NOT
    // record the mode here: leaving it unrecorded means this effect retries the
    // moment the worker goes idle, instead of stranding the session on the wrong
    // transport. The predicate is `surfaceTransportGate` above — the SAME one
    // the footer toggle greys its segment on, so the control and the effect can
    // never disagree about what is possible.
    if (surfaceTransportGate(live, viewMode).blocked) return;

    switching.current = true;
    void (async () => {
      let reconciled = false;
      try {
        // →PTY routes through `start()`/`open` (it must actually attach a live
        // PTY); →CLI is the `switch-mode` action, which kills the PTY and
        // persists `visible=false` + `pty_mode=false`. Dimensions are a terminal
        // concern only — the headless direction has no grid to size.
        await live.switchMode(
          wantPty ? WorkerMode.Interactive : WorkerMode.CLI,
          wantPty ? getDims?.() : undefined,
        );
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
          title: wantPty ? t`Could not switch to terminal` : t`Could not switch to chat`,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        switching.current = false;
        if (reconciled) setReconcileRevision((revision) => revision + 1);
      }
    })();
  }, [viewMode, live, ptyMode, turnInFlight, modeResolved, getDims, canSwitch, reconcileRevision]);

  return live;
}
