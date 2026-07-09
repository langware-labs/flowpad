import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { Callable } from '../types';
import { ConnectionManager, DataOp } from '../websocket';

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

/** Discriminator for special FlowMessage kinds. Mirrors
 *  flow_sdk.builtin.flow_message.FlowMessageKind exactly.
 *  - USER       : a normal message (the default for everything the user or
 *                 hub produces).
 *  - INVITATION : a local-only placeholder FlowMessage representing a pending
 *                 hub Invitation as the first row of a conversation; its
 *                 ``context_entities`` carry the backing Invitation TypeId so
 *                 the UI can read invitation_id off it for the Accept action. */
export enum FlowMessageKind {
  USER = 'user',
  INVITATION = 'invitation',
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
  /** Prompt attachments (legacy PROMPT or prompt-entity TYPE_ID): the user who suggested the prompt. */
  proposer_id?: string | null;
  /** Prompt attachments: set when the other party approves. */
  approved_by?: string | null;
  /** Prompt-entity TYPE_ID attachments: inline copy of the prompt text so receivers
   *  can preview/execute before the body bundle is downloaded. NOTE: this field (and
   *  proposer_id/approved_by) must also exist on the HUB's Attachment model — the hub
   *  silently drops unknown fields on the round-trip. */
  prompt_preview?: string | null;
}

/** Delivery receipt. Mirrors the hub-side schema. Monotonic transitions only:
 *  created → sent → delivered → received.
 *  - created:   local only, hub has not accepted it (🕐 Pending)
 *  - sent:      accepted/stored on the hub (✓)
 *  - delivered: recipient's client pulled it (✓✓)
 *  - received:  recipient read it (✓✓ blue) */
export type DeliveryStatus = 'created' | 'sent' | 'delivered' | 'received';

/** Named event types emitted by ``Conversation`` and ``FlowMessage``. Use
 *  these instead of bare strings so call sites are typo-proof:
 *    conversation.on(ConversationEvents.MESSAGE, msg => ...)  // new inbound message
 *    conversation.on(ConversationEvents.ACK, msg => ...)      // a receipt changed
 *    message.on(ConversationEvents.ACK, () => ...)            // this message's receipt
 *    await message.waitForAck(timeoutMs)                      // resolve once received
 */
export enum ConversationEvents {
  /** A new inbound FlowMessage arrived on the conversation. */
  MESSAGE = 'message',
  /** A FlowMessage's delivery_status changed (delivered / received). */
  ACK = 'ack',
}

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
  /** Special-message discriminator. USER (default) is a normal message;
   *  INVITATION marks a local-only placeholder representing a pending hub
   *  Invitation as the first row of a conversation. The invitation TypeId
   *  lives in ``context_entities``. */
  kind?: FlowMessageKind;
  /** Body-bundle lifecycle on the hub. Defaults to NA when the message has
   *  no body. Stamped UPLOADING at hub add_message time when the incoming
   *  attachments require a packed body; sender flips to READY after upload.
   *  Receivers gate downloads on READY. */
  body_status?: BodyStatus;
  /** Transient, server-derived (API responses only — never stored). True once
   *  this message has a body AND that body has been pulled + unpacked locally,
   *  i.e. every renderable body attachment is on disk (files materialized,
   *  TYPE_ID entity assets have a local record). The UI switches the whole
   *  message between a single Download button and rendered chips off this one
   *  flag, so the transcript and the context panel share download state. */
  body_downloaded?: boolean;
  /** Forward provenance: id of the source FlowMessage this one was forwarded
   *  from (set only on forwarded clones — see forwardMessage). */
  cloned_from_id?: string | null;
  /** Original sender of the source message (for the "forwarded" chip). */
  cloned_from_sender_id?: string | null;
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
  kind?: FlowMessageKind;
  body_status?: BodyStatus;
  body_downloaded?: boolean;
  cloned_from_id?: string | null;
  cloned_from_sender_id?: string | null;
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
    this.kind = entity.kind ?? FlowMessageKind.USER;
    this.body_status = entity.body_status ?? BodyStatus.NA;
    this.body_downloaded = entity.body_downloaded ?? false;
    this.cloned_from_id = entity.cloned_from_id ?? null;
    this.cloned_from_sender_id = entity.cloned_from_sender_id ?? null;
  }

  /** Promote a draft message to a real reply: flips is_draft=false, appends to conversation.jsonl, pushes to hub. */
  async sendDraft(): Promise<{ flow_message_id: string; conversation_id: string; message_count: number }> {
    const action = new ActionInfo('send-draft', 'flow_message', this.id ?? null, 'POST');
    const res = await dataManager.callAction<
      unknown,
      { flow_message_id: string; conversation_id: string; message_count: number }
    >(action);
    return res!;
  }

  /** Delete this message everywhere. Allowed only for the sender of the
   *  message or the conversation owner — the backend (and hub) enforce that
   *  gate. On a shared conversation this fans a DELETE out to every
   *  participant; the message's entire existence (DB row + on-disk record
   *  folder) is erased. POSTs /api/v1/graph/flow_message/<id>/remove-message. */
  async remove(): Promise<void> {
    if (!this.id) throw new Error('remove requires this.id');
    const action = new ActionInfo('remove-message', FlowMessage.type, this.id, 'POST');
    await dataManager.callAction<unknown, unknown>(action);
  }

  // -------- Header / Body interface (principle #6) -------- //

  /** True iff at least one attachment requires a packed body bundle.
   *  Mirrors flow_sdk.builtin.flow_message.FlowMessage.has_body exactly. */
  hasBody(): boolean {
    for (const att of this.attachment ?? []) {
      if (att.attachment_type === AttachmentType.FILE) return true;
      if (att.attachment_type === AttachmentType.TYPE_ID) return true;
      if (att.attachment_type === AttachmentType.PROMPT && (att.data ?? '').startsWith(PROMPT_FILE_VFS_PREFIX)) {
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
  async uploadBody(_opts: { onProgress?: (pct: number) => void; transferMode?: 'copy' | 'git' } = {}): Promise<this> {
    if (!this.id) throw new Error('uploadBody requires this.id');
    const action = new ActionInfo('upload_body', FlowMessage.type, this.id, 'POST');
    action.bodyParameters = { transfer_mode: _opts.transferMode ?? 'copy' };
    await dataManager.callAction<unknown, unknown>(action);
    this.body_status = BodyStatus.READY;
    this.attachment_filename = BODY_FILENAME;
    return this;
  }

  /** Download + unpack this message's body via the local backend.
   *  Throws BodyNotReadyError when body_status != READY.
   *  POSTs /api/v1/graph/flow_message/<id>/download_body. */
  async downloadBody(
    _opts: { onProgress?: (pct: number) => void; overwrite?: boolean } = {},
  ): Promise<this> {
    if (this.body_status !== BodyStatus.READY) {
      throw new BodyNotReadyError(this.body_status);
    }
    if (!this.id) throw new Error('downloadBody requires this.id');
    const action = new ActionInfo('download_body', FlowMessage.type, this.id, 'POST');
    // On a genuine collision the backend replies 409 {asset_conflict:true}; the
    // caller can re-invoke with overwrite:true to replace the on-disk asset.
    action.bodyParameters = { overwrite: _opts.overwrite ?? false };
    await dataManager.callAction<unknown, unknown>(action);
    return this;
  }

  /**
   * The single UI entrypoint for pulling this message's attachment bytes onto
   * local disk — every download surface (chips, context panel, prompt build)
   * goes through here rather than building an ``fs/download`` URL by hand.
   *
   * This is frontend gate #1: when there is no downloadable body
   * (``body_status`` NA = none was ever uploaded, UPLOADING = not landed yet)
   * it is a NO-OP — we never fire a request that the backend would have to 404.
   * Only a READY body delegates to ``downloadBody()`` (which posts the
   * ``download_body`` action and unpacks; ``attachment[].local_path`` then
   * materialises and an entity UPDATE re-renders the chips as downloaded).
   */
  async downloadAttachments(opts: { onProgress?: (pct: number) => void } = {}): Promise<this> {
    if (this.body_status !== BodyStatus.READY) return this;
    return this.downloadBody(opts);
  }

  // -------- Realtime receipt (ack) subscription -------- //

  private _ackTapOff: (() => void) | null = null;

  /**
   * Subscribe to receipt changes on THIS message.
   *
   * ``message.on(ConversationEvents.ACK, m => ...)`` fires every time the
   * hub fans a delivery_status update (delivered → received) back for this
   * message id; the callback receives the updated ``IFlowMessage``. Any
   * other event type falls through to the base emitter unchanged.
   */
  override on(eventType: string | string[], callback: Callable): () => void {
    const types = Array.isArray(eventType) ? eventType : [eventType];
    if (types.includes(ConversationEvents.ACK)) {
      this._ensureAckTap();
    }
    const baseOff = super.on(eventType, callback);
    return () => {
      baseOff();
      if (types.includes(ConversationEvents.ACK)) {
        this._maybeTearDownAckTap();
      }
    };
  }

  /**
   * Resolve once this message reaches delivery_status='received' (the
   * receiver has read it), or reject after ``timeoutMs``. Resolves
   * immediately when the message is already received — replaces the manual
   * "poll getById().delivery_status" loop.
   */
  waitForAck(timeoutMs = 15_000): Promise<this> {
    if (this.delivery_status === 'received') return Promise.resolve(this);
    return new Promise<this>((resolve, reject) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error(`waitForAck timed out after ${timeoutMs}ms (message ${this.id})`));
      }, timeoutMs);
      off = this.on(ConversationEvents.ACK, (m: IFlowMessage) => {
        if (m.delivery_status !== 'received') return;
        // Mirror the receipt onto this entity so callers can read it
        // straight away regardless of data_op listener ordering.
        this.delivery_status = m.delivery_status;
        this.received_at = m.received_at ?? this.received_at;
        this.delivered_at = m.delivered_at ?? this.delivered_at;
        clearTimeout(timer);
        off?.();
        resolve(this);
      });
    });
  }

  /** Install a low-level data_op tap that emits ``ACK`` for update frames
   *  carrying a delivery_status change on this message id. Idempotent. */
  private _ensureAckTap(): void {
    if (this._ackTapOff) return;
    const cm = ConnectionManager.getInstance();
    const handler = (typeIdStr: string, op: string, data: any) => {
      if (op !== DataOp.UPDATE) return;
      const dash = typeIdStr.indexOf('-');
      if (dash <= 0) return;
      if (typeIdStr.slice(0, dash) !== FlowMessage.type) return;
      if (typeIdStr.slice(dash + 1) !== this.id) return;
      if (!data || data.delivery_status == null) return;
      this.emit(ConversationEvents.ACK, data as IFlowMessage);
    };
    cm.on('on_data_op', handler);
    this._ackTapOff = () => cm.off('on_data_op', handler);
  }

  /** Tear the tap down once the last ACK listener unsubscribes. */
  private _maybeTearDownAckTap(): void {
    if (this._eventListeners.get(ConversationEvents.ACK)?.length) return;
    this._ackTapOff?.();
    this._ackTapOff = null;
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

export interface ForwardMessageResult {
  conversation_id: string;
  message_count?: number;
  flow_message_id: string;
  cloned_from_id?: string | null;
}

/**
 * Forward an existing message into another conversation. The backend clones
 * it (new id, the caller as sender, fresh timestamps, `cloned_from_id`
 * provenance, copied attachment bytes) and dispatches the clone through the
 * same pipeline as a fresh send — hub header + body upload included.
 * POSTs /api/v1/graph/flow_message/<id>/forward.
 */
export async function forwardMessage(
  flowMessageId: string,
  conversationId: string,
): Promise<ForwardMessageResult> {
  const action = new ActionInfo('forward', FlowMessage.type, flowMessageId, 'POST');
  action.bodyParameters = { conversation_id: conversationId };
  const res = await dataManager.callAction<{ conversation_id: string }, ForwardMessageResult>(action);
  return res!;
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
