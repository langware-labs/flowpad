import { AgenticProcess, TypeId, isBusy } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useEffect, useMemo, useRef } from 'react';

/**
 * Converge a remounted chat pane with the on-disk transcript exactly once.
 *
 * A browser reload closes the per-turn HTTP response stream while the backend
 * turn keeps running: the remount's plain `loadHistory()` fetches whatever the
 * transcript holds at that moment, and no stream consumer remains to append
 * the frames the turn produces afterwards. This hook watches the backend's
 * busy projection (`is_turn_busy` → `busy` — NOT raw `worker_status`
 * telemetry, which is nullable/oscillating wire state): if a turn is already
 * in flight when the pane first observes the process, it arms a one-shot
 * latch and force-reloads history on the busy→ready falling edge.
 *
 * One-shot by construction:
 * - first observation idle → the mount `loadHistory()` already fetched the
 *   full transcript; nothing to converge, the latch closes for good.
 * - first observation busy → exactly one force reload when that turn ends.
 * - later busy oscillations (turns submitted from this pane) never refire —
 *   those turns stream their own frames via `prompt()`, and every force
 *   reload is an expensive `clear()` + full re-append.
 */
export function useTurnCompletionReconcile(process: AgenticProcess): void {
  const processTypeId = useMemo(() => new TypeId(AgenticProcess.type, process.id), [process.id]);
  const { data: liveProcess } = useEntity<AgenticProcess>(processTypeId, { watch: true });
  const busy = liveProcess ? isBusy(liveProcess) : undefined;

  const latchRef = useRef<'undecided' | 'armed' | 'done'>('undecided');
  useEffect(() => {
    latchRef.current = 'undecided';
  }, [process.id]);

  useEffect(() => {
    if (busy === undefined) return; // entity not observed yet — defer the decision
    if (latchRef.current === 'undecided') {
      latchRef.current = busy ? 'armed' : 'done';
      return;
    }
    if (latchRef.current !== 'armed' || busy) return;
    latchRef.current = 'done';
    void process.loadHistory({ force: true }).catch((err) => {
      console.error('[useTurnCompletionReconcile] completion history reconcile failed', err);
    });
  }, [busy, process]);
}
