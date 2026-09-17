import { ActionInfo, dataManager } from '@sdk';

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

/**
 * Full stream-inbox body search → conversation ids, server-side (`stream-inbox-search`).
 *
 * Not a `$LIKE` entity query: under the reference model a channel message's
 * body lives on its SourceItem — the FlowMessage row stores `text: ""` — so a
 * client-side match over FlowMessage.text would go blind to every ingested
 * message. The action searches both residences and returns the union.
 */
export async function searchStreamInbox(q: string, agentId?: string): Promise<Set<string>> {
  const action = new ActionInfo('stream-inbox-search', null, null, 'POST');
  action.bodyParameters = { q, ...(agentId ? { agent_id: agentId } : {}) };
  const result = await dataManager.callAction<{ q: string }, { conversation_ids?: string[] }>(action);
  return new Set(result?.conversation_ids ?? []);
}
