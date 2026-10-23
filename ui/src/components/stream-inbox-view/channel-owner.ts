import {
  Agent,
  Conversation,
  dataManager,
  type DataSource,
  ExpressionNode,
  QueryFilter,
  QueryRequest,
  TypeId,
  User,
} from '@sdk';
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
  // The stream inbox's own latest page (newest first, one page) — so a strip showing its top rows
  // asks the server for a page, not for every conversation.
  return conversationsPageRequest({ owner }, 'all', null);
}

/** The conversations matching `clauses`, newest first (`updated_date`), at most `limit` — a list that
 *  shows only its most recent rows asks the server for just those. */
export function recentConversationsRequest(clauses: ExpressionNode[], limit?: number, name?: string): QueryRequest {
  return new QueryRequest({
    type: Conversation.type,
    name,
    query: new QueryFilter({
      match: allOf(clauses) ?? new ExpressionNode({ op: '$IS_NOT_NULL', operands: ['id'] }),
      order_by: [{ updated_date: 'desc' }, { id: 'asc' }],
      ...(limit ? { limit } : {}),
    }),
  });
}

/** ``node`` where the server keeps the conversation ``field`` (``servesField``); nothing (match all) where it does not. */
export const whereKept = (field: string, node: ExpressionNode): ExpressionNode[] =>
  dataManager.servesField(Conversation.type, field) ? [node] : [];

/** The clauses AND-ed; no clause matches every row. */
export const allOf = (clauses: ExpressionNode[]): ExpressionNode | undefined =>
  clauses.length ? new ExpressionNode({ op: '$AND', operands: clauses }) : undefined;

/** Whose conversations: the owner clause, where the server keeps an ``owner``. */
const ownerClauses = (owner: TypeId): ExpressionNode[] => whereKept('owner', ownerMatch(owner));

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

const scopeClauses = (scope: ConversationScope): ExpressionNode[] =>
  'owner' in scope ? ownerClauses(scope.owner) : [sourceMatch(scope.sourceId)];

const notArchived = () =>
  new ExpressionNode({
    op: '$OR',
    operands: [
      new ExpressionNode({ op: '$EQ', operands: ['archived', false] }),
      // A row the recompute has not stamped yet (written before `archived` existed).
      new ExpressionNode({ op: '$IS_NULL', operands: ['archived'] }),
    ],
  });

const notDeleted = () => new ExpressionNode({ op: '$IS_NULL', operands: ['deleted_at'] });

/** The view's clause, answered by the backend from the projected `archived` / `is_unread`, so a page
 *  is N rows of the view rather than N rows the browser then thins out. */
function viewClauses(view: StreamInboxViewMode): ExpressionNode[] {
  if (view === 'archived') return [new ExpressionNode({ op: '$EQ', operands: ['archived', true] })];
  if (view === 'unread') return [notArchived(), new ExpressionNode({ op: '$EQ', operands: ['is_unread', true] })];
  return whereKept('archived', notArchived());
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
      // An owner still reads a conversation they deleted on the hub (kept there for audit, `deleted_at`
      // set); it is gone from the Stream Inbox. A row kept here never carries the field.
      match: allOf([...scopeClauses(scope), ...whereKept('deleted_at', notDeleted()), ...clauses]),
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
  const clauses = viewClauses(view);
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

/** The rows of the page just NEWER than one whose newest row is at `newest`: the `size` rows above it,
 *  oldest first — a keyset (`updated_date > newest`), never an offset, so a row arriving meanwhile
 *  cannot shift the bound. The last of them bounds the newer page (see `newerPageBefore`); fewer than
 *  a page — or no more past them — means the newer page is now. */
export function newerBoundaryRequest(
  scope: ConversationScope,
  view: StreamInboxViewMode,
  newest: string,
  size: number = STREAM_INBOX_PAGE_SIZE,
): QueryRequest {
  return pageQuery(
    scope,
    [...viewClauses(view), new ExpressionNode({ op: '$GT', operands: ['updated_date', newest] })],
    'asc',
    { limit: size },
  );
}

/** The newer page's `before` from the rows `newerBoundaryRequest` read: null (the newer page is now)
 *  unless they are a full page with more past them; else just past the last of them, so the newer page
 *  — rows older than its bound, newest first — is exactly those rows. */
export function newerPageBefore(
  above: { updated_date?: string | Date | null }[],
  hasMore: boolean,
  size: number = STREAM_INBOX_PAGE_SIZE,
): string | null {
  if (!hasMore || above.length < size) return null;
  const last = above[above.length - 1]?.updated_date;
  if (!last) return null;
  const at = new Date(last).getTime();
  return Number.isNaN(at) ? null : new Date(at + 1).toISOString();
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
