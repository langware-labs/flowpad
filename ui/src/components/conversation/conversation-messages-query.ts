import { Conversation, FlowMessage, QueryFilter, QueryRequest, TypeId } from '@sdk';

// Cap the initial messages window so long conversations don't fetch + watch
// every FlowMessage they've ever held. Newest-first so the visible window is
// always at the bottom of the conversation; older messages load on demand.
const CONVERSATION_MESSAGES_WINDOW = 500;

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

/** A conversation's newest message, for a row that keeps no pointer log (a hub row): the same scoped
 *  read, one row. */
export function latestConversationMessageRequest(conversationId: string): QueryRequest {
  return new QueryRequest({
    type: FlowMessage.type,
    scope: [new TypeId(Conversation.type, conversationId)],
    name: `latest-message:${conversationId}`,
    query: new QueryFilter({ limit: 1, order_by: { created_date: 'desc' } }),
  });
}
