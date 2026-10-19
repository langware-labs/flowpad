import { FlowMessage, QueryFilter, QueryRequest } from '@sdk';

// Cap the initial messages window so long conversations don't fetch + watch
// every FlowMessage they've ever held. Newest-first so the visible window is
// always at the bottom of the conversation; older messages load on demand.
const CONVERSATION_MESSAGES_WINDOW = 500;

/** The one request for a conversation's messages — ConversationView and the drawer's Tasks tab read
 *  the same watched query (identical requests share one fetch and one watch). */
export function conversationMessagesRequest(conversationId: string): QueryRequest {
  return new QueryRequest({
    type: FlowMessage.type,
    scope: [],
    name: `messages:${conversationId}`,
    query: new QueryFilter({
      match: {
        op: '$AND',
        operands: [{ op: '$EQ', operands: ['conversation_id', conversationId] }],
      } as Record<string, unknown>,
      limit: CONVERSATION_MESSAGES_WINDOW,
      order_by: { created_date: 'desc' },
    }),
  });
}
