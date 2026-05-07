import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

export enum DeliveryMode {
  EMAIL = 'email',
  REPO = 'repo',
}

export enum AttachmentType {
  TYPE_ID = 'type_id',
  FILE = 'file',
  REPO = 'repo',
  URL = 'url',
  PROMPT = 'prompt',
}

export interface Attachment {
  attachment_type: AttachmentType;
  /** TypeId string ("type-id"), relative file path, repo path, URL, or — for PROMPT — inline text or "prompt/<filename>" VFS subpath. */
  data: string;
  /** Absolute filesystem path — populated server-side for FILE / PROMPT-file attachments, null for others. */
  local_path?: string | null;
  /** PROMPT attachments only: the user who suggested the prompt. */
  proposer_id?: string | null;
  /** PROMPT attachments only: set when the other party approves. */
  approved_by?: string | null;
}

/** Three-state delivery receipt. Mirrors the hub-side schema. Monotonic
 *  transitions only: created → delivered → received. */
export type DeliveryStatus = 'created' | 'delivered' | 'received';

export interface IFlowMessage extends IEntity {
  text?: string;
  instruction?: string | null;
  attachment?: Attachment[];
  sender_id?: string | null;
  sender_name?: string | null;
  receiver_address?: string | null;
  receiver_address_type?: string | null;
  /** User-given filename of the uploaded .flowmsg zip stored via fs/upload, e.g. "my-share.flowmsg". Null when no file was uploaded. */
  attachment_filename?: string | null;
  /** ID of the parent Conversation; null on legacy messages predating the field. */
  conversation_id?: string | null;
  is_read?: boolean;
  is_archived?: boolean;
  /** Receipt state — orthogonal to the local-only `is_read` flag. Set only
   *  by the hub via mark_delivered / mark_received actions; flows back to
   *  the sender as a data_op_msg(update) frame, subject to the parent
   *  conversation's `message_status_visible` gate. */
  delivery_status?: DeliveryStatus;
  delivered_at?: string | null;
  received_at?: string | null;
  // NOTE: ``context`` (string[]) was renamed and consolidated into the
  // unified ``context_entities`` on IEntity. Read via
  // ``msg.contextEntities`` / ``msg.firstContextOfType('task')``.
  /** Local-only draft message: not appended to conversation.jsonl, not pushed to hub. Flips to false on send-draft. */
  is_draft?: boolean;
}

@registerEntity
export class FlowMessage extends APIEntity<FlowMessage> implements IFlowMessage {
  text?: string;
  instruction?: string | null;
  attachment?: Attachment[];
  sender_id?: string | null;
  sender_name?: string | null;
  receiver_address?: string | null;
  receiver_address_type?: string | null;
  attachment_filename?: string | null;
  conversation_id?: string | null;
  is_read?: boolean;
  is_archived?: boolean;
  delivery_status?: DeliveryStatus;
  delivered_at?: string | null;
  received_at?: string | null;
  is_draft?: boolean;
  static type: string = 'flow_message';

  constructor(entity: Partial<IFlowMessage> = {}) {
    super(entity);
    this.text = entity.text;
    this.instruction = entity.instruction;
    this.attachment = entity.attachment;
    this.sender_id = entity.sender_id;
    this.sender_name = entity.sender_name;
    this.receiver_address = entity.receiver_address;
    this.receiver_address_type = entity.receiver_address_type;
    this.attachment_filename = entity.attachment_filename;
    this.conversation_id = entity.conversation_id;
    this.is_read = entity.is_read ?? false;
    this.is_archived = entity.is_archived ?? false;
    this.delivery_status = entity.delivery_status ?? 'created';
    this.delivered_at = entity.delivered_at ?? null;
    this.received_at = entity.received_at ?? null;
    this.is_draft = entity.is_draft ?? false;
  }

  /** Promote a draft message to a real reply: flips is_draft=false, appends to conversation.jsonl, pushes to hub. */
  async sendDraft(): Promise<{ flow_message_id: string; conversation_id: string; message_count: number }> {
    const action = new ActionInfo('send-draft', 'flow_message', this.id ?? null, 'POST');
    const res = await dataManager.callAction<unknown, { flow_message_id: string; conversation_id: string; message_count: number }>(action);
    return res!;
  }
}

export interface UploadFlowMessageResult {
  message_id: string;
  task_id: string | null;
  conversation_id: string | null;
  was_new_task: boolean;
}

export interface UploadConflict {
  type: string;
  id: string;
}

export async function uploadFlowMessage(
  file: File,
  options: { overwrite?: boolean } = {},
): Promise<UploadFlowMessageResult> {
  const formData = new FormData();
  formData.append('file', file);

  const action = new ActionInfo('flow-message-upload', null, null, 'POST');
  if (options.overwrite) action.queryParameters = { overwrite: 'true' };
  action.bodyParameters = formData;
  const res = await dataManager.callAction<FormData, UploadFlowMessageResult>(action);
  return res!;
}

/** Returns the hub fs/download URL for a FlowMessage's stored .flowmsg bundle. */
export function downloadFlowMessageUrl(messageId: string, attachmentFilename: string): string {
  const action = new ActionInfo('fs', 'flow_message', messageId, 'GET');
  action.subpath = `download/${attachmentFilename}`;
  return action.fullActionUrl;
}

export interface CreateTaskBundleParams {
  spec_title: string;
  spec_content?: string;
  task_title?: string;
  message?: string | null;
  team_space_id?: string | null;
}

export interface CreateTaskBundleResult {
  flow_message_id: string;
  task_id: string;
  conversation_id: string;
  spec_id: string;
}

export async function createTaskBundle(params: CreateTaskBundleParams): Promise<CreateTaskBundleResult> {
  const action = new ActionInfo('flow-message-create', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<CreateTaskBundleParams, CreateTaskBundleResult>(action);
  return res!;
}

export interface MarkResult {
  updated?: string[];
  skipped?: Array<{ id: string; reason: string; current?: string }>;
}

/**
 * Batch read-ack: tells the local server (which forwards to the hub) that
 * the listed FlowMessages have been seen by the current user. Hub flips
 * their `delivery_status` to "received" and fans an UPDATE frame back to
 * the sender (subject to the parent conversation's `message_status_visible`).
 */
export async function markFlowMessagesReceived(flow_message_ids: string[]): Promise<MarkResult | null> {
  if (flow_message_ids.length === 0) return null;
  const action = new ActionInfo('mark_received', 'flow_message', null, 'POST');
  action.bodyParameters = { flow_message_ids };
  return dataManager.callAction<{ flow_message_ids: string[] }, MarkResult>(action);
}
