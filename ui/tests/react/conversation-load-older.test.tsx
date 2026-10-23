/**
 * A conversation longer than its message window (500): the feed draws the newest 500 — one bubble
 * per LOADED message, never a bubble that fetches its own message — and "Load older messages" pages
 * back by `created_date` (a keyset) until every message is drawn.
 *
 * Live backend: the messages are real rows linked to the conversation, the window and the older page are the
 * real scoped `conversation/<id>/flow_message` reads.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiClient, Conversation, GRAPH_API_PREFIX } from '@sdk';
import { ConversationView } from '@src/components/conversation/ConversationView';
import { CONVERSATION_MESSAGES_WINDOW } from '@src/components/conversation/conversation-messages-query';
import { ConversationContextPanel } from '@src/components/conversation/ConversationContextPanel';
import { apiTestSetup } from '../utils/test-utils';

const TOTAL = CONVERSATION_MESSAGES_WINDOW + 7;
let conversation: Conversation;

async function seed(conv: Conversation, count: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const n = ++next;
      // Created as the conversation's child — what every message is once it lands. (Seeding through
      // `add_message` rewrites the pointer log per message: minutes for 500.)
      await apiClient.post(`${GRAPH_API_PREFIX}/conversation/${conv.id}/flow_message`, { text: `message ${n}` });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

const bubbles = () => document.querySelectorAll('[data-testid^="message-bubble-"]').length;

describe('a conversation longer than its window', () => {
  beforeAll(async () => {
    await apiTestSetup();
    conversation = new Conversation({ title: `load-older ${Date.now()}` });
    await conversation.save();
    await seed(conversation, TOTAL);
  }, 120_000);

  afterAll(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('draws the newest window, then the older messages on "load older" — no per-message fetch', async () => {
    const get = vi.spyOn(apiClient, 'get');
    render(
      <MemoryRouter>
        <ConversationView conversationId={conversation.id} />
      </MemoryRouter>,
    );

    const loadOlder = await screen.findByTestId('conversation-load-older', {}, { timeout: 20_000 });
    await waitFor(() => expect(bubbles()).toBe(CONVERSATION_MESSAGES_WINDOW), { timeout: 20_000 });

    await act(async () => {
      fireEvent.click(loadOlder);
    });
    await waitFor(() => expect(bubbles()).toBe(TOTAL), { timeout: 20_000 });
    expect(screen.queryByTestId('conversation-load-older')).toBeNull();

    const urls = get.mock.calls.map(([url]) => String(url));
    // No bubble asked for its own message (the old desktop did one GET per older message).
    expect(urls.filter((url) => /\/flow_message\/[0-9a-f-]{36}$/.test(url))).toEqual([]);
    // The older page is the same scoped read, keyed by created_date — never an offset.
    const older = get.mock.calls.filter(
      ([url, config]) =>
        String(url).endsWith(`/conversation/${conversation.id}/flow_message`) &&
        JSON.stringify((config as { params?: unknown })?.params ?? {}).includes('$LT'),
    );
    expect(older.length).toBe(1);
    expect(JSON.stringify((older[0][1] as { params?: unknown }).params)).not.toContain('offset');
    get.mockRestore();
  }, 90_000);

  it("the context panel reads the conversation's own messages, not every message", async () => {
    cleanup();
    const get = vi.spyOn(apiClient, 'get');
    render(
      <MemoryRouter>
        <ConversationContextPanel task={null} conversation={conversation} conversationId={conversation.id} />
      </MemoryRouter>,
    );
    await waitFor(
      () =>
        expect(get.mock.calls.some(([url]) => String(url).endsWith(`/conversation/${conversation.id}/flow_message`))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    expect(get.mock.calls.filter(([url]) => /\/graph\/flow_message$/.test(String(url)))).toEqual([]);
    get.mockRestore();
  }, 30_000);
});
