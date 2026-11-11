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
import { Agent, apiClient, Conversation, dataManager, GRAPH_API_PREFIX } from '@sdk';
import { ConversationView } from '@src/components/conversation/ConversationView';
import {
  CONVERSATION_MESSAGES_WINDOW,
  conversationMessagesRequest,
} from '@src/components/conversation/conversation-messages-query';
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

/** An agent's view of a conversation draws only the messages in its scope — and none while the scope
 *  is still loading or comes back empty, whether the conversation keeps a pointer log or not. */
describe('an agent-scoped conversation with nothing in scope', () => {
  const AGENT = '9a9a9a9a-1111-4111-8111-9a9a9a9a9a9a';
  let logged: Conversation;
  let unlogged: Conversation;

  beforeAll(async () => {
    await apiTestSetup();
    logged = new Conversation({ title: `scope-logged ${Date.now()}` });
    await logged.save();
    await logged.addMessage('in the log');
    unlogged = new Conversation({ title: `scope-unlogged ${Date.now()}` });
    await unlogged.save();
    await seed(unlogged, 2);
  }, 60_000);

  afterAll(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const scopes = {
    pending: () => new Promise<never>(() => {}),
    empty: async () => ({ agent_id: AGENT, source_id: null, conversation_ids: [], thread_ids: [], flow_message_ids: [] }),
  };

  for (const [name, scope] of Object.entries(scopes)) {
    for (const which of ['logged', 'unlogged'] as const) {
      it(`${name} scope, ${which} conversation: no bubble, no ack`, async () => {
        cleanup();
        vi.spyOn(Agent.prototype, 'streamInboxScope').mockImplementation(scope as never);
        const acks = vi.spyOn(dataManager, 'callAction');
        const conv = which === 'logged' ? logged : unlogged;
        render(
          <MemoryRouter>
            <ConversationView conversationId={conv.id} agentId={AGENT} />
          </MemoryRouter>,
        );
        // The window has landed (its rows are cached) and still nothing is drawn.
        await waitFor(
          () => expect(windowLoaded(conv.id)).toBe(true),
          { timeout: 10_000 },
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(bubbles()).toBe(0);
        expect(acks.mock.calls.filter(([a]) => (a as { name?: string })?.name === 'mark_received')).toEqual([]);
        vi.restoreAllMocks();
      }, 30_000);
    }
  }
});

function windowLoaded(conversationId: string): boolean {
  const rows = dataManager.getCachedQueryResults(
    // the very request ConversationView watches
    conversationMessagesRequest(conversationId),
  );
  return !!rows && rows.length > 0;
}
