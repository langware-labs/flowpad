import { AgenticProcess, TypeId, isBusy } from '@sdk';
import { useEffect, useMemo, useRef } from 'react';
import { useEntity } from '@src/hooks/entity-hooks';

/**
 * Render a turn this client did not start.
 *
 * A turn's content reaches the client that sent it through that client's own
 * `prompt()` response stream. Every other surface — the chat pane after a
 * mid-turn switch to Standard, a second tab, vibe watching a worker-started
 * turn — has no source, and sits on a stale list behind a ticking activity line
 * until history reloads at turn end.
 *
 * So: when a turn is running and this client is not the one running it, open
 * the backend's read-only `observe-turn` stream for exactly as long as the pane
 * is mounted and the turn is alive. A session nobody is looking at costs
 * nothing — there is no broadcast, no subscription, no server-side fan-out.
 *
 * The `!isPrompting` gate is what keeps this from doubling rows: a client
 * either sent the turn (its own stream carries it) or observes it. Never both.
 */
export function useObservedTurn(process: AgenticProcess | null | undefined): void {
  const typeId = useMemo(
    () => (process ? new TypeId(AgenticProcess.type, process.id) : null),
    [process?.id],
  );
  // The WS-updated instance: the prop may be a loader-held object that never
  // re-renders on a `busy` flip.
  const { data: live } = useEntity<AgenticProcess>(typeId, { watch: true });
  const reflected = live ?? process ?? null;
  const busy = !!reflected && isBusy(reflected);

  // One observation per turn. Without this the effect would re-open the stream
  // on every unrelated re-render while `busy` stays true — and a re-open
  // re-watermarks the transcript, so anything written in the gap is skipped.
  const observing = useRef(false);

  useEffect(() => {
    // `process` (not `reflected`) is the acting instance: it owns the
    // flowDataStream the pane renders and the `isPrompting` counter.
    // A request that races the backend's own liveness read can come back as an
    // already-closed empty stream; the effect then simply opens again on the
    // next `busy` render. One wasted round trip, no lost rows — the retry
    // re-watermarks against a transcript nothing was streamed from.
    if (!process || !busy || process.isPrompting || observing.current) return;
    observing.current = true;
    const ctrl = new AbortController();
    void process
      .observeTurn(ctrl)
      .catch((err) => {
        if (ctrl.signal.aborted) return; // unmounted / turn moved on — expected
        console.debug('[useObservedTurn] observation ended', err);
      })
      .finally(() => {
        observing.current = false;
      });
    // Cleanup runs on unmount AND when `busy` flips false — which is exactly
    // how the observation ends for a turn whose provider never wrote a turn-end
    // marker (a killed or crashed worker). The client owns the stop decision
    // because it is the one that knows whether it still cares.
    return () => ctrl.abort();
  }, [process, busy]);
}
