import { useEffect } from 'react';
import { DataSource } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

/**
 * Attention-driven polling, request-based: while the conversation showing
 * this source's output is the SELECTED dock (the URL says so), fire
 * `request_poll` on an interval — each request makes the source due on the
 * next heartbeat tick, and for a driver that declares a sub-tick attention
 * cadence (telegram: 5s) it renews the poller's fast-lane lease. The request
 * stream IS the liveness signal: nothing is stored on the entity, so when
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
//: keeps the source continuously due while watched; it also bounds the lag
//: between selecting and the first request when the view was already mounted.
const REQUEST_EVERY_MS = 25_000;

function isSelectedSourceView(conversationId?: string, agentId?: string): boolean {
  try {
    const dock = DockPointer.fromUrl(`${window.location.pathname}${window.location.search}`);
    if (conversationId) {
      return (
        dock?.viewType === ViewType.CONVERSATION &&
        DockPointer.parseConversationPointer(dock?.pointer).conversationId === conversationId
      );
    }
    const agent = DockPointer.parseAgentPointer(dock?.pointer);
    return dock?.viewType === ViewType.AGENT && agent.view === 'inbox' && agent.agentId === agentId;
  } catch {
    return false;
  }
}

async function requestPoll(sourceId: string): Promise<void> {
  const ds =
    DataSource.getByIdFromCache<DataSource>(sourceId) ??
    (await DataSource.getById<DataSource>(sourceId));
  await ds?.requestPoll();
}

export function useAttentionPolling(
  sourceId: string | undefined,
  conversationId: string | undefined,
  agentId?: string,
): void {
  useEffect(() => {
    if (!sourceId || (!conversationId && !agentId)) return;
    const tick = () => {
      if (!isSelectedSourceView(conversationId, agentId)) return;
      void requestPoll(sourceId).catch(() => {
        // Best effort: a failed request just means the standing cadence.
      });
    };
    tick();
    const timer = setInterval(tick, REQUEST_EVERY_MS);
    return () => clearInterval(timer);
  }, [sourceId, conversationId, agentId]);
}
