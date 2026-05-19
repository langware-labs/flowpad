import { ActionInfo, dataManager } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';

export type InboxAttachment = Attachment;

export interface InboxMessage {
  id: string;
  text: string;
  instruction?: string | null;
  /** TypeId strings e.g. "task-abc123". Renamed from ``context`` to match the unified ``context_entities`` on the entity. */
  context_entities: string[];
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

/** Bulk mark all read / unread / archive all */
export async function bulkUpdateMessages(
  patch: { is_read?: boolean; is_archived?: boolean },
): Promise<BulkUpdateResult> {
  const action = new ActionInfo('inbox-bulk-update', null, null, 'POST');
  action.bodyParameters = patch;
  const result = await dataManager.callAction<typeof patch, BulkUpdateResult>(action);
  return result ?? { updated: 0 };
}
