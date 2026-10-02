/**
 * `useEntity().refetch()` reads the BACKEND, not the cache.
 *
 * A local agent deployment runs in its own process and saves a reply into the
 * conversation straight to the database — no socket of the app announces that
 * write, so the browser's cached Conversation keeps its old message pointers.
 * The conversation view learns of the reply from the relayed `projected` tag and
 * calls `refetch()`; a cache-first refetch handed the stale entry straight back,
 * and the reply's bubble never appeared until a page reload
 * (ui/tests/manual_regression/conversation/agent_email_gmail_round_trip.md.ts).
 *
 * The refetch must also reach every OTHER subscriber of the same entity, since
 * the cached object is merged in place.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, Conversation, dataManager, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';

const CONVERSATION_ID = '6f3c1b5e-2a4d-4c8e-9b7a-1d2e3f4a5b6c';
const QUESTION_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const REPLY_ID = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';

function conversationJson(messageIds: string[]) {
  return {
    type: Conversation.type,
    id: CONVERSATION_ID,
    message_ids: JSON.stringify(
      messageIds.map((id, i) => ({ typeid: `flow_message-${id}`, ts: `2026-10-02T10:00:0${i}Z` })),
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useEntity refetch', () => {
  it('re-reads a cached entity from the backend and updates every subscriber', async () => {
    const typeId = new TypeId(Conversation.type, CONVERSATION_ID);
    dataManager.invalidateCacheByTypeId(typeId);

    // The backend before the deployment process wrote the reply, then after.
    let onDisk = conversationJson([QUESTION_ID]);
    const getSpy = vi.spyOn(apiClient, 'get').mockImplementation(async () => structuredClone(onDisk) as never);

    const view = renderHook(() => useEntity<Conversation>(typeId));
    const header = renderHook(() => useEntity<Conversation>(typeId));
    await waitFor(() => expect(view.result.current.data?.conversationMessageIds.map((p) => p.id)).toEqual([QUESTION_ID]));
    await waitFor(() => expect(header.result.current.data?.conversationMessageIds.map((p) => p.id)).toEqual([QUESTION_ID]));
    const readsBefore = getSpy.mock.calls.length;

    // The reply lands in another process: no entity op reaches this client.
    onDisk = conversationJson([QUESTION_ID, REPLY_ID]);

    await act(async () => {
      await view.result.current.refetch();
    });

    expect(getSpy.mock.calls.length).toBe(readsBefore + 1);
    expect(view.result.current.data?.conversationMessageIds.map((p) => p.id)).toEqual([QUESTION_ID, REPLY_ID]);
    await waitFor(() =>
      expect(header.result.current.data?.conversationMessageIds.map((p) => p.id)).toEqual([QUESTION_ID, REPLY_ID]),
    );
  });

  it('answers null — not a throw — when the entity was deleted since it was cached', async () => {
    const typeId = new TypeId(Conversation.type, CONVERSATION_ID);
    dataManager.invalidateCacheByTypeId(typeId);

    let deleted = false;
    vi.spyOn(apiClient, 'get').mockImplementation(async () => {
      if (deleted) throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      return structuredClone(conversationJson([QUESTION_ID])) as never;
    });
    const consoleError = vi.spyOn(console, 'error');

    const view = renderHook(() => useEntity<Conversation>(typeId));
    await waitFor(() => expect(view.result.current.data?.conversationMessageIds.map((p) => p.id)).toEqual([QUESTION_ID]));

    deleted = true;
    await act(async () => {
      await view.result.current.refetch();
    });

    expect(view.result.current.isError).toBe(false);
    expect(view.result.current.data).toBeNull();
    expect(view.result.current.notFound).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
