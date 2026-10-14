import { t } from '@lingui/core/macro';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isBusy, WorkerMode, type AgenticProcess } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useViewMode, viewModePtyMode, ViewMode } from '@src/contexts/view-mode-context';
import { notify } from '@src/notifications/notify';

interface UseProcessSurfaceOptions {
  process?: AgenticProcess | null;
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

/**
 * Why a process's transport switch is waiting, keyed by process id: the agent is
 * mid-turn (`busy`), or its turn ended but background work it launched (a
 * background shell, a subagent) still runs in the PTY and would die with it —
 * the server's `switch-mode` 409s on that with {@link BACKGROUND_TASKS_RUNNING}.
 * `switching` is a →chat request in flight: `switchMode` stages `pty_mode=false`
 * before the server answers, so without it the pane flipped to chat and then
 * back to the terminal when the server refused.
 * Read by {@link useSurfaceSwitchWait} so the screen can say why it has not
 * switched yet.
 */
export type SurfaceSwitchWait = 'busy' | 'background' | 'switching';
const switchWaits = new Map<string, SurfaceSwitchWait>();
const switchWaitListeners = new Set<() => void>();

function setSwitchWait(processId: string, wait: SurfaceSwitchWait | null): void {
  if ((switchWaits.get(processId) ?? null) === wait) return;
  if (wait) switchWaits.set(processId, wait);
  else switchWaits.delete(processId);
  switchWaitListeners.forEach((listener) => listener());
}

function subscribeSwitchWaits(listener: () => void): () => void {
  switchWaitListeners.add(listener);
  return () => switchWaitListeners.delete(listener);
}

/** Why this process's transport switch is held back right now, or null. */
export function useSurfaceSwitchWait(processId: string | null | undefined): SurfaceSwitchWait | null {
  return useSyncExternalStore(subscribeSwitchWaits, () => (processId ? (switchWaits.get(processId) ?? null) : null));
}

/** The server's `switch-mode` 409 message while background work still runs
 *  (`BACKGROUND_TASKS_RUNNING` in `agentic_process.py`). */
export const BACKGROUND_TASKS_RUNNING = 'background tasks are running';

/** The server's reason for refusing a switch: an HTTP refusal carries it in the
 *  envelope (`response.data.message`), a WebSocket one as the Error's message. */
function refusalMessage(err: unknown): string {
  const envelope = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data;
  if (typeof envelope?.message === 'string') return envelope.message;
  return err instanceof Error ? err.message : String(err);
}

/** Test seam: forget what each process was reconciled to. */
export function resetSurfaceReconcileState(): void {
  lastReconciledMode.clear();
  switchWaits.clear();
}

/** The backend action a transport change lands on. Both directions share ONE
 *  route now, and therefore one guard — see the gate below. */
export type TransportRoute = 'switch-mode';

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
 * ONE predicate for "can this session change transport now", shared by the
 * reconcile effect and the session's `SessionSurfaceSwitch`, mirroring the one server answer:
 * `switch-mode` 409s while `is_turn_busy`, in both directions. →PTY used to take
 * the unguarded `open`, so this blocked nothing there (FLOWPAD-2130). Keyed on
 * BUSY: a FAILED session and an `/exit`-ed PTY are not ready but need the click.
 */
export function surfaceTransportGate(
  process: AgenticProcess | null | undefined,
  viewMode: ViewMode,
): SurfaceTransportGate {
  if (!process) return { needsSwitch: false, route: null, blocked: false };
  const wantPty = viewModePtyMode(viewMode);
  const ptyMode = !(process.isHeadless ?? false);
  if (wantPty === ptyMode) return { needsSwitch: false, route: null, blocked: false };
  return { needsSwitch: true, route: 'switch-mode', blocked: isBusy(process) };
}

/**
 * Keep one process's TRANSPORT aligned with the view mode — the whole of what a
 * session needs beyond rendering, now that the session's `SessionSurfaceSwitch` is the single
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
 * `surfaceTransportGate` above: a transport switch is declined while `busy`,
 * keyed on the same `is_turn_busy` predicate the backend 409s on, so the two
 * can never disagree. That symmetry only holds
 * since `switchMode` put BOTH directions on `switch-mode`: while →PTY took the
 * unguarded `open`, a mid-turn →terminal went through and put a second worker on
 * the live turn's own transcript (FLOWPAD-2130).
 *
 * Chat/vibe and the terminal are MUTUALLY EXCLUSIVE: a session on a chat or
 * vibe surface never keeps a PTY. So first sight reconciles too, in both
 * directions — a PTY-backed session opened straight into chat (a reload, a
 * `?viewMode=standard` link) used to be left on its PTY, and a question it then
 * asked waited in a terminal nobody could see. What first sight still never
 * does is act when the transport already matches.
 *
 * A switch the worker cannot take yet — mid-turn, or background work still
 * running in the PTY — waits, and says so through {@link useSurfaceSwitchWait};
 * `InteractiveTerminal` keeps the terminal on screen until it lands, so the
 * surface never shows a chat over a live PTY. It retries when `busy` flips: a
 * finished background task wakes the agent with its task-notification, and that
 * turn's end is the next edge.
 *
 * By default it returns the reactive entity it subscribes to; an existing
 * `useEntity` owner can disable that subscription and receive its own process
 * back unchanged.
 */
export function useProcessSurface({
  process,
  canSwitch = true,
  subscribeToProcess = true,
}: UseProcessSurfaceOptions): AgenticProcess | null {
  // The tab's stated mode (or the app's one mode) — never the stored preference,
  // so it is known at once and there is no late-resolving value to wait out.
  const viewMode = useViewMode();
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null, {
    enabled: subscribeToProcess,
  });
  const live = liveProcess ?? process ?? null;
  const ptyMode = !(live?.isHeadless ?? false);
  // `busy`, NOT `!isReadyForInput` — they are not complements (a FAILED session
  // and an `/exit`-ed PTY are neither); see `surfaceTransportGate`. Read here so
  // the effect RE-RUNS when it flips, which is what retries a decline at idle.
  const turnInFlight = isBusy(live ?? {});
  // The transcript's latest entry. A short turn can flip `busy` true→false
  // inside one render, so a switch held back for background work also retries
  // on every new entry — the task-notification that ends the work is one.
  const transcriptEntry = live?.worker_status_detail_id ?? null;
  // A chat worker parked on background work is not `busy`, so ending that work flips no edge the
  // effect watches: the switch held back for it (→terminal) retries when the work is gone.
  const backgroundWork = !!live?.background_work;
  // Guards re-entry with the CURRENT value rather than a closed-over one, and
  // keeps a transport switch from re-rendering every mounted session twice.
  const switching = useRef(false);
  // A URL mode can change while the previous lifecycle promise is still in
  // flight. Ref completion alone does not re-run an effect that returned on
  // `switching.current`; this revision drains the latest desired mode after a
  // successful switch without immediately retrying failures.
  const [reconcileRevision, setReconcileRevision] = useState(0);

  useEffect(() => {
    if (!live || switching.current) return;
    const key = live.id;
    const previous = lastReconciledMode.get(key);
    const wantPty = viewModePtyMode(viewMode);
    // First sight records the mode and acts only on a transport mismatch, which
    // falls through to the switch below. That path records only once the switch
    // happened, so a startup `canSwitch=false` still retries instead of
    // stranding the session.
    if (previous === undefined && wantPty === ptyMode) {
      lastReconciledMode.set(key, viewMode);
      return;
    }
    if (previous === viewMode) return;

    if (wantPty === ptyMode) {
      setSwitchWait(key, null);
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
    // the session switch greys its segment on. Background work is not `busy`:
    // that pick lands, the server 409s, and SurfaceSwitchWaitNotice says why.
    if (surfaceTransportGate(live, viewMode).blocked) {
      setSwitchWait(key, 'busy');
      return;
    }

    switching.current = true;
    if (!wantPty) setSwitchWait(key, 'switching');
    void (async () => {
      let reconciled = false;
      try {
        // One route, so one mid-turn guard: →PTY attaches off the same open
        // payload `start()` returns, →CLI kills the PTY and clears `pty_mode`.
        // No size: the mounted terminal view asserts its own grid on the attach.
        await live.switchMode(wantPty ? WorkerMode.Interactive : WorkerMode.CLI);
        lastReconciledMode.set(key, viewMode);
        setSwitchWait(key, null);
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
        // Background work still running in the PTY: not a failure. Wait for it,
        // leaving the mode unrecorded so the next `busy` edge retries.
        if (refusalMessage(err).includes(BACKGROUND_TASKS_RUNNING)) {
          setSwitchWait(key, 'background');
          return;
        }
        setSwitchWait(key, null);
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
  }, [viewMode, live, ptyMode, turnInFlight, transcriptEntry, backgroundWork, canSwitch, reconcileRevision]);

  return live;
}
