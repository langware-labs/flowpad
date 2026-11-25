import { ActionInfo, Agent, dataManager } from '@sdk';
import { ConnectionManager } from '@sdk/websocket';
import type { ConversationScope } from './channel-owner';

export interface FetchResult {
  created: number;
  ids: string[];
}

export interface UpdateResult {
  id: string;
  is_read: boolean;
  is_archived: boolean;
}

export interface BulkUpdateResult {
  updated: number;
}

/** Mark a single message read/unread or archived/unarchived */
export async function updateMessage(
  messageId: string,
  patch: { is_read?: boolean; is_archived?: boolean },
  agentId?: string,
): Promise<UpdateResult | null> {
  const action = new ActionInfo('stream-inbox-update', 'flow_message', messageId, 'POST');
  action.bodyParameters = { ...patch, ...(agentId ? { agent_id: agentId } : {}) };
  return dataManager.callAction<typeof patch, UpdateResult>(action);
}

export interface OpenResult {
  task_id: string | null;
  conversation_id: string | null;
}

/** Materialize the task for a FlowMessage (downloads bundle if task missing locally). */
export async function openStreamInboxMessage(messageId: string): Promise<OpenResult | null> {
  const action = new ActionInfo('stream-inbox-open', 'flow_message', messageId, 'GET');
  return dataManager.callAction<null, OpenResult>(action);
}

/**
 * Pull new/changed hub messages for ONE conversation into the local store.
 * The backend (`conversation-message-sync`) lists the conversation's child
 * FlowMessages in a single request and refreshes only the stale ones (LWW by
 * updated_date), so the local live query reflects the hub on resolve. Replaces
 * the old per-message backfill loop (one `openStreamInboxMessage` per pointer).
 */
export async function syncConversationMessages(conversationId: string, agentId?: string): Promise<void> {
  const action = new ActionInfo('conversation-message-sync', null, null, 'POST');
  // The route reads only `conversation_id`; scoping there is the hub's authorization.
  action.bodyParameters = { conversation_id: conversationId };
  await dataManager.callAction(action);
}

/** Bulk mark all read / unread / archive all */
export async function bulkUpdateMessages(
  patch: { is_read?: boolean; is_archived?: boolean },
  agentId?: string,
): Promise<BulkUpdateResult> {
  const action = new ActionInfo('stream-inbox-bulk-update', null, null, 'POST');
  action.bodyParameters = { ...patch, ...(agentId ? { agent_id: agentId } : {}) };
  const result = await dataManager.callAction<typeof patch, BulkUpdateResult>(action);
  return result ?? { updated: 0 };
}

/** What a whole-inbox search asks for: one text per column of the list, each '' when not asked. */
export interface StreamInboxSearch {
  /** Who wrote in the conversation or is in it, by name or address. */
  from: string;
  /** The conversation's title. */
  subject: string;
  /** A message's body. */
  q: string;
}

/**
 * Whole stream-inbox search → the ids of the conversations matching every text given, server-side
 * (`stream-inbox-search`).
 *
 * Not a `$LIKE` entity query: a sender is on the messages, not on the conversation, and under the
 * reference model a channel message's body lives on its SourceItem — the FlowMessage row stores
 * `text: ""` — so a match over the rows here would go blind to every ingested message.
 */
export async function searchStreamInbox(
  search: StreamInboxSearch,
  agentId?: string,
  tags: string[] = [],
): Promise<string[]> {
  const action = new ActionInfo('stream-inbox-search', null, null, 'POST');
  action.bodyParameters = { ...search, ...(tags.length ? { tags } : {}), ...(agentId ? { agent_id: agentId } : {}) };
  const result = await dataManager.callAction<StreamInboxSearch, { conversation_ids?: string[] }>(action);
  return result?.conversation_ids ?? [];
}

/** Re-evaluate a server-owned tag filter when its source rows change, without polling. */
export function watchMessageTags(changed: () => void): () => void {
  const connection = ConnectionManager.getInstance();
  const listener = (typeId: string, _op: string, data: { tags?: string[] } | null) => {
    if (typeId.startsWith('flow_message-') && data?.tags !== undefined) changed();
  };
  connection.on('on_data_op', listener);
  return () => connection.off('on_data_op', listener);
}

export interface LoadOlderResult {
  fetched: number;
  /** No source has anything older to give: what is held is all there is. */
  exhausted: boolean;
}

/**
 * Ask a stream inbox's sources (an owner's, or one source's) for the page of messages older than
 * `before` (`stream-inbox-load-older`). What arrives projects into conversations like any message,
 * and the live page query picks them up — this only asks. An agent's stream inbox is named by `agent_id`,
 * as every stream-inbox action names it; the local user's by nothing.
 */
export async function loadOlderConversations(before: string, scope: ConversationScope): Promise<LoadOlderResult> {
  const action = new ActionInfo('stream-inbox-load-older', null, null, 'POST');
  action.bodyParameters = {
    before,
    ...('sourceId' in scope
      ? { source_id: scope.sourceId }
      : scope.owner.type === Agent.type
        ? { agent_id: scope.owner.id }
        : {}),
  };
  const result = await dataManager.callAction<Record<string, string>, LoadOlderResult>(action);
  return result ?? { fetched: 0, exhausted: true };
}
