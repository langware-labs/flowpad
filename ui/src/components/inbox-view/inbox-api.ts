import { ActionInfo, dataManager } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';

export type InboxAttachment = Attachment;

export interface InboxMessage {
  id: string;
  text: string;
  instruction?: string | null;
  /** TypeId strings e.g. "task-abc123". Mirrors the wire-bound
   *  ``shared_context_entities`` bucket on the entity — published context
   *  that travels with the FlowMessage. */
  shared_context_entities: string[];
  attachment: InboxAttachment[];
  sender_id?: string | null;
  sender_name?: string | null;
  receiver_address?: string | null;
  /** ID of the parent Conversation; null on legacy messages predating the field. */
  conversation_id?: string | null;
  is_read: boolean;
  is_archived: boolean;
  created_date?: string | null;
}

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

/** Load all non-archived FlowMessages from local DB */
export async function listInboxMessages(): Promise<InboxMessage[]> {
  const action = new ActionInfo('inbox-list', null, null, 'GET');
  const result = await dataManager.callAction<null, InboxMessage[]>(action);
  return result ?? [];
}

/** Mark a single message read/unread or archived/unarchived */
export async function updateMessage(
  messageId: string,
  patch: { is_read?: boolean; is_archived?: boolean },
): Promise<UpdateResult | null> {
  const action = new ActionInfo('inbox-update', 'flow_message', messageId, 'POST');
  action.bodyParameters = patch;
  return dataManager.callAction<typeof patch, UpdateResult>(action);
}

export interface OpenResult {
  task_id: string | null;
  conversation_id: string | null;
}

/** Materialize the task for a FlowMessage (downloads bundle if task missing locally). */
export async function openInboxMessage(messageId: string): Promise<OpenResult | null> {
  const action = new ActionInfo('inbox-open', 'flow_message', messageId, 'GET');
  return dataManager.callAction<null, OpenResult>(action);
}

/**
 * Pull new/changed hub messages for ONE conversation into the local store.
 * The backend (`conversation-message-sync`) lists the conversation's child
 * FlowMessages in a single request and refreshes only the stale ones (LWW by
 * updated_date), so the local live query reflects the hub on resolve. Replaces
 * the old per-message backfill loop (one `openInboxMessage` per pointer).
 */
export async function syncConversationMessages(conversationId: string): Promise<void> {
  const action = new ActionInfo('conversation-message-sync', null, null, 'POST');
  action.bodyParameters = { conversation_id: conversationId };
  await dataManager.callAction(action);
}

/** Bulk mark all read / unread / archive all */
export async function bulkUpdateMessages(
  patch: { is_read?: boolean; is_archived?: boolean },
): Promise<BulkUpdateResult> {
  const action = new ActionInfo('inbox-bulk-update', null, null, 'POST');
  action.bodyParameters = patch;
  const result = await dataManager.callAction<typeof patch, BulkUpdateResult>(action);
  return result ?? { updated: 0 };
}

/**
 * Full-inbox body search → conversation ids, server-side (`inbox-search`).
 *
 * Not a `$LIKE` entity query: under the reference model a channel message's
 * body lives on its SourceItem — the FlowMessage row stores `text: ""` — so a
 * client-side match over FlowMessage.text would go blind to every ingested
 * message. The action searches both residences and returns the union.
 */
export async function searchInbox(q: string): Promise<Set<string>> {
  const action = new ActionInfo('inbox-search', null, null, 'POST');
  action.bodyParameters = { q };
  const result = await dataManager.callAction<{ q: string }, { conversation_ids?: string[] }>(action);
  return new Set(result?.conversation_ids ?? []);
}
