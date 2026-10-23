import { Conversation, ExpressionNode, FlowMessage, QueryFilter, QueryRequest, TypeId } from '@sdk';

// Cap the initial messages window so long conversations don't fetch + watch
// every FlowMessage they've ever held. Newest-first so the visible window is
// always at the bottom of the conversation; older messages load on demand.
export const CONVERSATION_MESSAGES_WINDOW = 500;

/** The one request for a conversation's messages — ConversationView and the drawer's Tasks tab read
 *  the same watched query (identical requests share one fetch and one watch).
 *
 *  A conversation's messages are its children (``GET conversation/<id>/flow_message``), on the hub
 *  and on the desktop alike: every message is linked to its conversation when it lands
 *  (``materialize_flow_message``). */
export function conversationMessagesRequest(conversationId: string): QueryRequest {
  return new QueryRequest({
    type: FlowMessage.type,
    scope: [new TypeId(Conversation.type, conversationId)],
    name: `messages:${conversationId}`,
    query: new QueryFilter({ limit: CONVERSATION_MESSAGES_WINDOW, order_by: { created_date: 'desc' } }),
  });
}

/** The page of a conversation's messages just OLDER than `before` (the oldest one loaded): a keyset
 *  on `created_date`, newest first — so a message arriving meanwhile never shifts it. */
export function olderConversationMessagesRequest(conversationId: string, before: string): QueryRequest {
  return new QueryRequest({
    type: FlowMessage.type,
    scope: [new TypeId(Conversation.type, conversationId)],
    name: `older-messages:${conversationId}:${before}`,
    query: new QueryFilter({
      match: new ExpressionNode({ op: '$LT', operands: ['created_date', before] }),
      limit: CONVERSATION_MESSAGES_WINDOW,
      order_by: [{ created_date: 'desc' }, { id: 'desc' }],
    }),
  });
}

/** The oldest `created_date` among `messages`, as the ISO string a keyset compares on. */
export function oldestCreatedDate(messages: { created_date?: string | Date | null }[]): string | null {
  let oldest: number | null = null;
  for (const message of messages) {
    const at = message.created_date ? new Date(message.created_date).getTime() : NaN;
    if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

/** The pointers a feed draws: from the oldest LOADED message on. A pointer older than every loaded
 *  message is a message not loaded yet — "load older" brings it — and drawing it would make its bubble
 *  fetch itself, one request per older message. Nothing loaded yet: every pointer (the window decides). */
export function loadedPointers<P extends { id: string }>(pointers: P[], loaded: ReadonlySet<string>): P[] {
  const first = pointers.findIndex((pointer) => loaded.has(pointer.id));
  return first <= 0 ? pointers : pointers.slice(first);
}
