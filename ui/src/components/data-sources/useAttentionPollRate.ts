import { useEffect, useRef } from 'react';
import { DataSource } from '@sdk';
import type { PollRate } from '@sdk';

/**
 * Attention-driven polling: while a view showing this source's output is
 * SELECTED (the URL says so), the source's `poll_rate` is `active` — the
 * backend polls it every heartbeat tick, and polls IMMEDIATELY on the
 * idle→active save; when deselected it returns to `idle` within one check
 * tick. The backend also decays a stale `active` on its own, so a crashed
 * tab costs at most the decay window, never a permanently-fast source.
 *
 * Why an interval + imperative URL check instead of reactive state: dock
 * tabs are kept MOUNTED when backgrounded (Radix `data-[state=inactive]`,
 * see ConversationRoute.tsx) and — measured in this session — a hidden
 * tab's subtree does not re-render on URL changes, so neither an unmount
 * cleanup nor a `useLocation`-derived prop ever fires for it. A plain JS
 * timer runs regardless of rendering, and the URL is the selection's
 * source of truth anyway (URL-first).
 *
 * Module-level count of WATCHING instances, not per-mount toggles: the view
 * can be mounted twice for one conversation and two conversations can share
 * a source. Only the 0→1 edge writes `active`, only the 1→0 edge writes
 * `idle` — a middle deselect must not slow the source down for a viewer
 * still watching.
 */
const watchers = new Map<string, number>();

//: How often each mounted view re-evaluates its selection. Also the worst-case
//: lag between deselecting and the idle write — well under the backend decay.
const CHECK_EVERY_MS = 15_000;

async function writeRate(sourceId: string, rate: PollRate): Promise<void> {
  const ds =
    DataSource.getByIdFromCache<DataSource>(sourceId) ??
    (await DataSource.getById<DataSource>(sourceId));
  if (!ds || ds.poll_rate === rate) return; // write only on change — no broadcast churn
  ds.poll_rate = rate;
  await ds.save();
  ds.markEdit();
}

function adjust(sourceId: string, delta: 1 | -1): void {
  const count = Math.max(0, (watchers.get(sourceId) ?? 0) + delta);
  if (count === 0) watchers.delete(sourceId);
  else watchers.set(sourceId, count);
  if (delta === 1 && count === 1) void writeRate(sourceId, 'active').catch(() => {});
  if (delta === -1 && count === 0) void writeRate(sourceId, 'idle').catch(() => {});
}

export function useAttentionPollRate(
  sourceId: string | undefined,
  isWatching: () => boolean,
): void {
  const watchingRef = useRef(isWatching);
  watchingRef.current = isWatching;

  useEffect(() => {
    if (!sourceId) return;
    let wanted = false;
    const tick = () => {
      const want = watchingRef.current();
      if (want !== wanted) {
        wanted = want;
        adjust(sourceId, want ? 1 : -1);
      } else if (want) {
        // LEVEL, not just edge: the backend can flip the source back to idle
        // underneath a continuous viewer (the decay after ACTIVE_DECAY_SECONDS
        // does exactly that), and an edge-only loop would never re-assert.
        // The WS-refreshed cache makes this a no-op while nothing changed.
        void writeRate(sourceId, 'active').catch(() => {});
      }
    };
    tick();
    const timer = setInterval(tick, CHECK_EVERY_MS);
    return () => {
      clearInterval(timer);
      if (wanted) adjust(sourceId, -1); // tab closed while watching
    };
  }, [sourceId]);
}
