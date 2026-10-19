import { Agent, Conversation, type DataSource, ExpressionNode, QueryFilter, QueryRequest, TypeId, User } from '@sdk';
import { type AttentionReason, attentionReason } from '@src/components/data-sources/source-attention';

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
  return new QueryRequest({ type: Conversation.type, query: new QueryFilter({ match: ownerMatch(owner) }) });
}

function ownerMatch(owner: TypeId): ExpressionNode {
  const owned = new ExpressionNode({ op: '$EQ', operands: ['owner', owner.toString()] });
  return owner.type === Agent.type
    ? owned
    : new ExpressionNode({ op: '$OR', operands: [owned, new ExpressionNode({ op: '$IS_NULL', operands: ['owner'] })] });
}

function sourceMatch(sourceId: string): ExpressionNode {
  return new ExpressionNode({ op: '$EQ', operands: ['channel_source_id', sourceId] });
}

/** The conversations that came through ONE data source — what a source's page lists. Backend-filtered on
 *  `channel_source_id` (stamped when a conversation adopts its channel; `flow_sdk/builtin/conversation.py`), so the
 *  page never loads its owner's whole stream inbox to narrow it. One source has one owner, so no owner clause is needed. */
export function sourceConversationsRequest(sourceId: string): QueryRequest {
  return new QueryRequest({ type: Conversation.type, query: new QueryFilter({ match: sourceMatch(sourceId) }) });
}

export type StreamInboxViewMode = 'all' | 'unread' | 'archived';

/** How many conversations one page of a stream inbox shows. */
export const STREAM_INBOX_PAGE_SIZE = 100;

/** Which conversations a page lists: an owner's stream inbox, or one data source's. */
export type ConversationScope = { owner: TypeId } | { sourceId: string };

/** A scope as a string: what keys a memo or a request on it. */
export const scopeKey = (scope: ConversationScope) => ('owner' in scope ? scope.owner.toString() : scope.sourceId);

const scopeMatch = (scope: ConversationScope) =>
  'owner' in scope ? ownerMatch(scope.owner) : sourceMatch(scope.sourceId);

const notArchived = () =>
  new ExpressionNode({
    op: '$OR',
    operands: [
      new ExpressionNode({ op: '$EQ', operands: ['archived', false] }),
      // A row the recompute has not stamped yet (written before `archived` existed).
      new ExpressionNode({ op: '$IS_NULL', operands: ['archived'] }),
    ],
  });

/** The view's clause, answered by the backend from the projected `archived` / `is_unread`, so a page
 *  is N rows of the view rather than N rows the browser then thins out. */
function viewMatch(view: StreamInboxViewMode): ExpressionNode {
  if (view === 'archived') return new ExpressionNode({ op: '$EQ', operands: ['archived', true] });
  if (view === 'unread')
    return new ExpressionNode({
      op: '$AND',
      operands: [notArchived(), new ExpressionNode({ op: '$EQ', operands: ['is_unread', true] })],
    });
  return notArchived();
}

/** The scope's conversations matching `clauses`, in recency order — the ONE ordering every page and
 *  boundary uses, so Older and Newer always agree on where a page ends. */
function pageQuery(
  scope: ConversationScope,
  clauses: ExpressionNode[],
  direction: 'asc' | 'desc',
  page: { limit: number; offset?: number },
): QueryRequest {
  return new QueryRequest({
    type: Conversation.type,
    query: new QueryFilter({
      match: new ExpressionNode({ op: '$AND', operands: [scopeMatch(scope), ...clauses] }),
      order_by: [{ updated_date: direction }, { id: 'asc' }],
      ...page,
    }),
  });
}

/** One page of a stream inbox, newest first: `before` null is now — the latest page — else the rows
 *  whose `updated_date` is older than it (a keyset, so new arrivals never shift an older page). */
export function conversationsPageRequest(
  scope: ConversationScope,
  view: StreamInboxViewMode,
  before: string | null,
  size: number = STREAM_INBOX_PAGE_SIZE,
): QueryRequest {
  const clauses = [viewMatch(view)];
  if (before) clauses.push(new ExpressionNode({ op: '$LT', operands: ['updated_date', before] }));
  return pageQuery(scope, clauses, 'desc', { limit: size });
}

/** The scope's conversations among `ids` (a body search's hits), newest first — every view, archived
 *  included, as search spans them. */
export function conversationsByIdsRequest(scope: ConversationScope, ids: string[]): QueryRequest {
  return pageQuery(scope, [new ExpressionNode({ op: '$IN', operands: ['id', ids] })], 'desc', {
    limit: STREAM_INBOX_PAGE_SIZE,
  });
}

/** The bound of the page just NEWER than one whose newest row is at `newest`: the row `size + 1` above
 *  it (one row, read oldest first). Its `updated_date` is the newer page's `before`; no such row means
 *  the newer page is now. */
export function newerBoundaryRequest(
  scope: ConversationScope,
  view: StreamInboxViewMode,
  newest: string,
  size: number = STREAM_INBOX_PAGE_SIZE,
): QueryRequest {
  return pageQuery(scope, [viewMatch(view), new ExpressionNode({ op: '$GT', operands: ['updated_date', newest] })], 'asc', {
    limit: 1,
    offset: size,
  });
}

/** The identity a channel mark draws: provider AND channel, because one transport
 *  (`agent`) reaches several channels and wears a different glyph for each. */
export const channelKeyOf = (s: DataSource) => `${s.provider}|${s.channel}`;

export interface AttentionItem {
  source: DataSource;
  reason: AttentionReason;
}

/** The sources among `rows` whose channel the list is narrowed to and that are not delivering,
 *  each with why — what the attention strip above the list draws. */
export function attentionAmong(rows: DataSource[], selected: ReadonlySet<string>): AttentionItem[] {
  return rows
    .filter((source) => selected.has(channelKeyOf(source)))
    .flatMap((source) => {
      const reason = attentionReason(source);
      return reason ? [{ source, reason }] : [];
    });
}
