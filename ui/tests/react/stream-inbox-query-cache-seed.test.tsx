/**
 * Switch proof for the inbox FLICKER bug.
 *
 * Symptom: every time the inbox is opened it flashed a full-screen "Loading…"
 * spinner before the rows appeared. RCA cause: `<InboxView/>` fully
 * unmounts/remounts on every open, and `useEntitiesQuery` hard-reset its state to
 * `{ data: undefined, isLoading: true }` on every (re)subscribe — throwing away
 * the already-warm query cache and forcing a loading frame. The fix seeds the
 * hook's initial + resubscribe state from `dataManager.getCachedQueryResults`.
 *
 * This drives the REAL `useEntitiesQuery` hook against the REAL `dataManager`
 * cache. The only stand-in is the HTTP boundary (`apiClient.get`) — stubbed to
 * return the server's rows, exactly as the backend would — so the cache is
 * populated through the real code path, not hand-forced.
 *
 * Faithful model of the app: the home `RecentConversationsStrip` stays mounted
 * and keeps the shared conversations query warm; the inbox opens, closes
 * (unmounts), and reopens (remounts). The switch is proven both directions:
 *   - warm remount  → first committed snapshot already has rows, isLoading=false
 *   - cold request  → first committed snapshot is { isLoading:true, data:undefined }
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation, QueryRequest, dataManager } from '@sdk';
import apiClient from '@sdk/client';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

const convJson = (id: string, updated_date: string) => ({
  type: 'conversation',
  id,
  updated_date,
  message_ids: '[]',
});

// Each surface builds its OWN request object (a distinct instance) but with the
// same type/query/scope → the same cache key, so they share cached results. The
// request MUST be stable across a hook's renders (the app memoizes it); an inline
// `new QueryRequest()` per render changes the auto-generated name every render and
// re-subscribes forever. We give each a fixed name and reuse the instance.
const conversationsRequest = (name: string) =>
  new QueryRequest({ type: Conversation.type, name });

afterEach(async () => {
  vi.restoreAllMocks();
  await dataManager.clearCache();
});

describe('useEntitiesQuery cache-seed (inbox flicker fix)', () => {
  it('seeds a warm remount on the first frame; a cold request still shows the loading frame', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([
      convJson('11111111-1111-4111-8111-111111111111', '2026-06-02T00:00:00Z'),
      convJson('22222222-2222-4222-8222-222222222222', '2026-06-01T00:00:00Z'),
    ] as never);

    // The persistent home strip: mounts once, loads, and stays mounted — keeping
    // the shared conversations query warm for everyone else (like the real app),
    // so the inbox opening later is a warm remount.
    const stripRequest = conversationsRequest('strip');
    const strip = renderHook(() => useEntitiesQuery<Conversation>(stripRequest));
    await waitFor(() => expect(strip.result.current.isSuccess).toBe(true));
    expect(strip.result.current.data).toHaveLength(2);

    // Inbox opens (a brand-new mount — the scenario that flickered). We must
    // inspect the FIRST committed frame, not the settled state: pre-fix the first
    // frame was { isLoading:true, data:undefined } (the "Loading…" flash) and then
    // resolved to data a microtask later — so asserting the settled state can't
    // tell the fix from the bug. Record every render and assert frame 0.
    const inboxFrames: Array<{ isLoading: boolean; len: number | undefined }> = [];
    const inboxRequest = conversationsRequest('inbox');
    renderHook(() => {
      const r = useEntitiesQuery<Conversation>(inboxRequest);
      inboxFrames.push({ isLoading: r.isLoading, len: r.data?.length });
      return r;
    });
    // THE SWITCH: with the cache seed the very first frame already has the rows
    // and is not loading. Without the seed this is { isLoading:true, len:undefined }.
    expect(inboxFrames[0]).toEqual({ isLoading: false, len: 2 });

    // Negative direction: a DIFFERENT request key that was never warmed shows the
    // loading frame first — confirming the seeded frame above comes from the warm
    // cache, not an incidental side effect. (Same first-frame capture.)
    const coldFrames: Array<{ isLoading: boolean; len: number | undefined }> = [];
    const coldRequest = new QueryRequest({
      type: Conversation.type,
      name: 'cold',
      query: { match: { op: '$EQ', operands: ['id', 'never-queried'] } },
    });
    renderHook(() => {
      const r = useEntitiesQuery<Conversation>(coldRequest);
      coldFrames.push({ isLoading: r.isLoading, len: r.data?.length });
      return r;
    });
    expect(coldFrames[0]).toEqual({ isLoading: true, len: undefined });
  });
});
