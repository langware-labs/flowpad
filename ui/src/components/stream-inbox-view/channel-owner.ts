import { Agent, Conversation, type DataSource, ExpressionNode, QueryFilter, QueryRequest, TypeId, User } from '@sdk';

/** The backend's `owner_of` rule (`flow_sdk/stream_inbox/projection.py`), client-side, for a
 *  row written before `owner` existed: the agent its legacy `config.agent_id` names,
 *  else `null` — "the local user's", which the CALLER resolves, so a mount that is
 *  not the local user's never has to know that typeid. */
export function ownerOf(source: Pick<DataSource, 'owner' | 'config'>): string | null {
  if (source.owner) return source.owner;
  const agentId = (source.config as { agent_id?: unknown } | undefined)?.agent_id;
  return typeof agentId === 'string' && agentId ? new TypeId(Agent.type, agentId).toString() : null;
}

/** Whose channels a stream inbox shows: the agent's on an agent stream inbox, else the local
 *  user's — `localUser.id`, not the SDK's `userTypeId`, which is the `@local`
 *  pointer while rows carry the user's real id. Null until that id is known. */
export function channelsOwnerFor(agentId: string | undefined, localUserId: string | undefined): TypeId | null {
  if (agentId) return new TypeId(Agent.type, agentId);
  return localUserId ? new TypeId(User.type, localUserId) : null;
}

/** The conversations a stream inbox lists — a live query the BACKEND filters by owner, so the
 *  browser neither loads every conversation nor narrows them itself. An agent's stream inbox is
 *  exactly what it owns; the local user's also holds rows written before `owner` existed
 *  (unowned — `owner_of`'s rule; a hub runtime's rows carry no owner, so they all match). Every
 *  surface listing the user's conversations builds its request HERE: the same query is the same
 *  cache key, which is what makes opening the stream inbox a warm remount instead of a loading
 *  flash. */
export function streamInboxConversationsRequest(owner: TypeId): QueryRequest {
  const owned = new ExpressionNode({ op: '$EQ', operands: ['owner', owner.toString()] });
  const match =
    owner.type === Agent.type
      ? owned
      : new ExpressionNode({ op: '$OR', operands: [owned, new ExpressionNode({ op: '$IS_NULL', operands: ['owner'] })] });
  return new QueryRequest({ type: Conversation.type, query: new QueryFilter({ match }) });
}

/** The conversations that came through ONE data source — what a source's page lists. Backend-filtered on
 *  `channel_source_id` (stamped when a conversation adopts its channel; `flow_sdk/builtin/conversation.py`), so the
 *  page never loads its owner's whole inbox to narrow it. One source has one owner, so no owner clause is needed. */
export function sourceConversationsRequest(sourceId: string): QueryRequest {
  const match = new ExpressionNode({ op: '$EQ', operands: ['channel_source_id', sourceId] });
  return new QueryRequest({ type: Conversation.type, query: new QueryFilter({ match }) });
}
