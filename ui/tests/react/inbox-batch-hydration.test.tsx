/**
 * X2 regression lock: the Inbox hydrates every row's first+latest FlowMessage
 * through ONE batched ``$IN`` query (warming the shared cache) instead of one
 * ``getByTypeId`` GET per row (N+1).
 *
 * The test drives the REAL ``InboxView`` + real entity-hooks over a spied
 * ``dataManager``: ``watchQuery`` serves the conversation list and records the
 * batch query; ``getByTypeIdFromCache`` serves the pre-warmed FlowMessages so
 * the rows resolve from cache; ``getByTypeId`` (the per-row GET) is counted and
 * must never fire for a FlowMessage.
 *
 * FAIL-before: before the fix no FlowMessage ``$IN`` query was issued, so the
 * single-batch assertion fails (rows fell back to N per-row GETs).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation, FlowMessage, QueryRequest, dataManager } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import '@src/i18n-init';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({
    cloudUser: { id: 'me-id', email: 'me@example.com' },
    currentUser: null,
  }),
  useCloudStatus: () => ({ connection: { status: 'connected' } }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn() },
    currentDock: null,
  }),
}));

vi.mock('@src/store/use-inbox-store', () => ({
  useInboxStore: () => ({ unreadCount: 0, setUnreadCount: vi.fn() }),
}));

vi.mock('@src/components/inbox-view/inbox-api', () => ({
  listInboxMessages: vi.fn(async () => []),
  updateMessage: vi.fn(async () => {}),
  bulkUpdateMessages: vi.fn(async () => {}),
}));

vi.mock('@src/components/inbox-view/MembershipInvitations', () => ({
  MembershipInvitations: () => null,
}));

vi.mock('@src/components/new-conversation-dialog/NewConversationDialog', () => ({
  NewConversationDialog: () => null,
}));

// Keep @sdk real (Conversation/FlowMessage/dataManager) but neutralise the
// network actions InboxView fires on mount.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    fetchConversations: vi.fn(async () => []),
    listCommunityTickets: vi.fn(async () => ({ tickets: [] })),
  };
});

import { InboxView } from '@src/components/inbox-view/InboxView';

const N = 5; // conversations → 2N (=10) first+latest FlowMessage pointer ids

function makeConversations() {
  const convs: Conversation[] = [];
  const messages: FlowMessage[] = [];
  for (let i = 0; i < N; i++) {
    const firstId = `1${i}111111-1111-4111-8111-111111111111`;
    const lastId = `2${i}222222-2222-4222-8222-222222222222`;
    const ts1 = `2026-06-1${i}T10:00:00Z`;
    const ts2 = `2026-06-1${i}T12:00:00Z`;
    convs.push(
      new Conversation({
        id: `c${i}111111-1111-4111-8111-111111111111`,
        title: `Conversation ${i}`,
        remote: true,
        created_by: 'someone-else',
        updated_date: ts2,
        message_ids: JSON.stringify([
          { typeid: `flow_message-${firstId}`, ts: ts1 },
          { typeid: `flow_message-${lastId}`, ts: ts2 },
        ]),
      }),
    );
    // ``saved`` is derived from ``created_by`` — set it so the entity reads as
    // persisted (mirrors a hydrated cache entity).
    const mk = (id: string, text: string) =>
      new FlowMessage({
        id,
        text,
        sender_name: `User ${i}`,
        is_read: true,
        conversation_id: `c${i}`,
        created_by: 'someone-else',
      });
    messages.push(mk(firstId, `first ${i}`), mk(lastId, `latest ${i}`));
  }
  return { convs, messages };
}

describe('Inbox batch FlowMessage hydration (X2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues ONE FlowMessage $IN query for N rows and no per-row GETs', async () => {
    const { convs, messages } = makeConversations();

    // Pre-warmed cache: rows resolve their FlowMessages from here (the batch
    // query's job in production). getByTypeId (per-row GET) must stay at 0.
    const cache = new Map<string, FlowMessage>();
    for (const m of messages) cache.set(m.typeId.toString(), m);

    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation(
      (tid) => (cache.get(tid.toString()) as never) ?? null,
    );
    const subscribeSpy = vi
      .spyOn(dataManager, 'subscribe')
      .mockImplementation(() => () => {});
    const getByTypeIdSpy = vi
      .spyOn(dataManager, 'getByTypeId')
      .mockImplementation(async (tid) => (cache.get(tid.toString()) as never) ?? null);

    const watchRequests: QueryRequest[] = [];
    vi.spyOn(dataManager, 'watchQuery').mockImplementation(async (request) => {
      watchRequests.push(request);
      if (request.type === Conversation.type) {
        request.callback?.(convs as never[]);
      } else if (request.type === FlowMessage.type) {
        request.callback?.(messages as never[]);
      } else {
        request.callback?.([]);
      }
      return () => {};
    });
    vi.spyOn(dataManager, 'query').mockImplementation(async (request) =>
      (request.type === Conversation.type ? (convs as never[]) : []),
    );

    render(
      <I18nProvider i18n={i18n}>
        <TooltipProvider>
          <InboxView />
        </TooltipProvider>
      </I18nProvider>,
    );

    // Wait until the rows have rendered from the conversation list.
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-conversation-row').length).toBe(N);
    });

    const fmWatches = watchRequests.filter((r) => r.type === FlowMessage.type);
    // Exactly ONE batched FlowMessage query — not N.
    expect(fmWatches.length).toBe(1);

    const wire = fmWatches[0].query?.toJSON() as
      | { filter: { match: { op: string; operands: unknown[] } } }
      | undefined;
    expect(wire?.filter.match.op).toBe('$IN');
    const operands = wire?.filter.match.operands ?? [];
    expect(operands[0]).toBe('id');
    // The id list carries every first+latest pointer id (2N), intact (not a
    // mangled nested tree).
    expect(Array.isArray(operands[1])).toBe(true);
    expect((operands[1] as string[]).length).toBe(2 * N);

    // No per-row FlowMessage GET happened — rows read from the warmed cache.
    const fmGets = getByTypeIdSpy.mock.calls.filter(
      ([tid]) => tid.type === FlowMessage.type,
    );
    expect(fmGets.length).toBe(0);

    // Sanity: the subscribe spy was used (rows subscribe client-side, no network).
    expect(subscribeSpy).toHaveBeenCalled();
  });
});
