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

/** Lifecycle of a FlowMessage's body bundle on the hub. Mirrors
 *  flow_sdk.builtin.flow_message.BodyStatus exactly.
 *  - NA        : no body needed (text-only, or inline-only attachments).
 *  - UPLOADING : sender is staging the body; receivers must wait.
 *  - READY     : body is available at fs/download/<BODY_FILENAME>.
 *  Transitions are hub-enforced: NA is terminal; UPLOADING → READY only. */
export enum BodyStatus {
  NA = 'na',
  UPLOADING = 'uploading',
  READY = 'ready',
}

/** Single source of truth for the body filename on the hub blob store.
 *  Must match flow_sdk.builtin.flow_message.BODY_FILENAME exactly — the
 *  parity unit test asserts this literal. */
export const BODY_FILENAME = 'body.flowmsg';

/** VFS subpath prefix for PROMPT-with-file attachments. Mirrors
 *  flow_sdk.builtin.flow_message.PROMPT_FILE_VFS_PREFIX. */
const PROMPT_FILE_VFS_PREFIX = 'prompt/';

/** Thrown by downloadBody() when called on an FM whose body_status != READY. */
export class BodyNotReadyError extends Error {
  constructor(status: BodyStatus | undefined) {
    super(`download_body refused: body_status=${status} (must be READY)`);
    this.name = 'BodyNotReadyError';
  }
}

/** Read an Attachment's ``data`` field as a canonical string.
 *
 * The hub sometimes deserializes TYPE_ID attachments with ``data`` as a
 * parsed ``{type, id}`` TypeId object rather than the ``"<type>-<uuid>"``
 * string every UI consumer expects (chip rendering, ``.startsWith('prompt/')``,
 * ``.endsWith('.jsonl')``, ``.split('/')`` for filenames). Use this helper
 * at every read site so the shape variance is collapsed in one place.
 * Returns ``''`` when ``data`` is missing/unrecognized so consumers can use
 * length checks instead of typeof guards. */
export function attachmentDataString(a: Pick<Attachment, 'data'>): string {
  const d = a.data as unknown;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const obj = d as { type?: string; id?: string };
    if (typeof obj.type === 'string' && typeof obj.id === 'string') {
      return `${obj.type}-${obj.id}`;
    }
  }
  return '';
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
  /** Special-message discriminator. "user" (default) is a normal message;
   *  "invitation" marks a local-only placeholder representing a pending hub
   *  Invitation as the first row of a conversation. The invitation TypeId
   *  lives in ``context_entities``. */
  kind?: 'user' | 'invitation';
  /** Body-bundle lifecycle on the hub. Defaults to NA when the message has
   *  no body. Stamped UPLOADING at hub add_message time when the incoming
   *  attachments require a packed body; sender flips to READY after upload.
   *  Receivers gate downloads on READY. */
  body_status?: BodyStatus;
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
  kind?: 'user' | 'invitation';
  body_status?: BodyStatus;
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
    this.kind = entity.kind ?? 'user';
    this.body_status = entity.body_status ?? BodyStatus.NA;
  }

  /** Promote a draft message to a real reply: flips is_draft=false, appends to conversation.jsonl, pushes to hub. */
  async sendDraft(): Promise<{ flow_message_id: string; conversation_id: string; message_count: number }> {
    const action = new ActionInfo('send-draft', 'flow_message', this.id ?? null, 'POST');
    const res = await dataManager.callAction<unknown, { flow_message_id: string; conversation_id: string; message_count: number }>(action);
    return res!;
  }

  // -------- Header / Body interface (principle #6) -------- //

  /** True iff at least one attachment requires a packed body bundle.
   *  Mirrors flow_sdk.builtin.flow_message.FlowMessage.has_body exactly. */
  hasBody(): boolean {
    for (const att of this.attachment ?? []) {
      if (att.attachment_type === AttachmentType.FILE) return true;
      if (att.attachment_type === AttachmentType.TYPE_ID) return true;
      if (
        att.attachment_type === AttachmentType.PROMPT &&
        (att.data ?? '').startsWith(PROMPT_FILE_VFS_PREFIX)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Return the underlying attachment list (not a copy). */
  attachments(): Attachment[] {
    return this.attachment ?? [];
  }

  /** Pack + upload this message's body via the local backend, which handles
   *  the hub fs/upload and the body_status state transitions.
   *  POSTs /api/v1/graph/flow_message/<id>/upload_body. */
  async uploadBody(_opts: { onProgress?: (pct: number) => void } = {}): Promise<this> {
    if (!this.id) throw new Error('uploadBody requires this.id');
    const action = new ActionInfo('upload_body', FlowMessage.type, this.id, 'POST');
    await dataManager.callAction<unknown, unknown>(action);
    this.body_status = BodyStatus.READY;
    this.attachment_filename = BODY_FILENAME;
    return this;
  }

  /** Download + unpack this message's body via the local backend.
   *  Throws BodyNotReadyError when body_status != READY.
   *  POSTs /api/v1/graph/flow_message/<id>/download_body. */
  async downloadBody(_opts: { onProgress?: (pct: number) => void } = {}): Promise<this> {
    if (this.body_status !== BodyStatus.READY) {
      throw new BodyNotReadyError(this.body_status);
    }
    if (!this.id) throw new Error('downloadBody requires this.id');
    const action = new ActionInfo('download_body', FlowMessage.type, this.id, 'POST');
    await dataManager.callAction<unknown, unknown>(action);
    return this;
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
