import { useEffect, useRef } from 'react';
import { DataSource } from '@sdk';

/**
 * Attention-driven polling, request-based: while a view showing this source's
 * output is SELECTED (the URL says so), fire `request_poll` on an interval —
 * each request makes the source due on the next heartbeat tick (≤60s). The
 * request stream IS the liveness signal: nothing is stored on the entity, so
 * there is no active/idle state to desync, round-trip stale, or decay. When
 * the viewer goes away — deselect, tab close, crashed page — the requests
 * simply stop and the standing cadence resumes by itself.
 *
 * Why an interval + imperative URL check instead of react lifecycle: dock
 * tabs are kept MOUNTED when backgrounded (Radix `data-[state=inactive]`,
 * see ConversationRoute.tsx) and — measured — a hidden tab's subtree does not
 * re-render on URL changes, so neither unmount cleanups nor location-derived
 * props ever fire for it. A plain JS timer runs regardless of rendering, and
 * the URL is the selection's source of truth anyway (URL-first).
 *
 * Redundant callers are harmless (`request_poll` is idempotent), so there is
 * no ref-counting and no edges to get wrong.
 */

//: How often a selected view re-requests. Anything under the 60s heartbeat
//: keeps the source continuously due while watched; 25s also bounds the lag
//: between selecting and the first request when the view was already mounted.
const REQUEST_EVERY_MS = 25_000;

async function requestPoll(sourceId: string): Promise<void> {
  const ds =
    DataSource.getByIdFromCache<DataSource>(sourceId) ??
    (await DataSource.getById<DataSource>(sourceId));
  await ds?.requestPoll();
}

export function useAttentionPolling(
  sourceId: string | undefined,
  isWatching: () => boolean,
): void {
  const watchingRef = useRef(isWatching);
  watchingRef.current = isWatching;

  useEffect(() => {
    if (!sourceId) return;
    const tick = () => {
      if (!watchingRef.current()) return;
      void requestPoll(sourceId).catch(() => {
        // Best effort: a failed request just means the standing cadence.
      });
    };
    tick();
    const timer = setInterval(tick, REQUEST_EVERY_MS);
    return () => clearInterval(timer);
  }, [sourceId]);
}
