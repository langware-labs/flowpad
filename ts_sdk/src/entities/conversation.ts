import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { ConnectionManager, DataOp } from '../websocket';
import { Callable } from '../types';
import { ViewType } from '../utils/ui/view-types';
import { ConversationEvents, FlowMessage, type IFlowMessage } from './flow-message';

export interface ConversationMessage {
  role: string;       // "sender" | "recipient" | "bot"
  content: string;
  sender_id: string;
  timestamp: string;
}

/**
 * Parsed conversation pointer: each line of conversation.jsonl is stored as
 * {typeid: "flow_message-<uuid>", ts: "<ISO>"} on disk, but call sites want
 * the bare id + type + ts triple — that's what this getter returns.
 */
export interface ConversationMessagePointer {
  /** Entity id (uuid). */
  id: string;
  /** Entity type (e.g. "flow_message"). */
  type: string;
  /** ISO timestamp the pointer was appended. */
  ts: string;
}

interface RawConversationPointer {
  typeid: string;
  ts: string;
}

export interface ConversationParticipant {
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
}

export interface IConversation extends IEntity {
  /** Local Project FK — receiver picks via the mapping dialog; sender's own
   *  project at send time. Null until the receiver maps. */
  project_id?: string | null;
  /** Cross-machine identity of the *sender's* project. Drives the per-machine
   *  remote→local mapping table. Null on local-origin conversations. */
  remote_project_id?: string | null;
  /** Display name of the sender's project (for the mapping dialog copy). */
  remote_project_name?: string | null;
  message_count?: number;
  message_ids?: string | null;  // JSON-encoded RawConversationPointer[]
  participants?: ConversationParticipant[];
  /** User-set display title. Set at creation in NewConversationDialog and
   *  shipped through the bundle on cross-user send. */
  title?: string | null;
  /**
   * Per-conversation read-receipt visibility. When false, the hub suppresses
   * `delivered` / `received` UPDATE frames to the original sender (co-recipients
   * still see them). Mirrors the hub-side flag added in Phase 1.
   */
  message_status_visible?: boolean;
  /** Strip-only dismissal timestamp. Recent strip hides the row when set;
   *  auto-revives when a FlowMessage newer than this stamp arrives. Inbox
   *  ignores this field. Null = not dismissed. */
  dismissed_at?: string | Date | null;
  /** Conversation-level archive timestamp. Both Inbox and Recent strip hide
   *  the row when set; auto-revives when a FlowMessage newer than this stamp
   *  arrives. Per-message ``FlowMessage.is_read`` remains independent. */
  archived_at?: string | Date | null;
  // NOTE: task_id moved into context_entities. Use conv.firstContextOfType('task').
  // NOTE: data_path is derived from the canonical records-data path on the
  // server — not exposed as a stored field anymore.
}

@registerEntity
export class Conversation extends APIEntity<Conversation> implements IConversation {
  project_id?: string | null;
  remote_project_id?: string | null;
  remote_project_name?: string | null;
  message_count?: number;
  message_ids?: string | null;
  participants?: ConversationParticipant[];
  title?: string | null;
  message_status_visible?: boolean;
  dismissed_at?: string | Date | null;
  archived_at?: string | Date | null;
  static type: string = 'conversation';

  constructor(entity: Partial<IConversation> = {}) {
    super(entity);
    this.project_id = entity.project_id;
    this.remote_project_id = entity.remote_project_id;
    this.remote_project_name = entity.remote_project_name;
    this.message_count = entity.message_count;
    this.message_ids = entity.message_ids;
    this.participants = entity.participants;
    this.title = entity.title;
    this.message_status_visible = entity.message_status_visible ?? true;
    this.dismissed_at = entity.dismissed_at ?? null;
    this.archived_at = entity.archived_at ?? null;
  }

  /** Surface the project as a chip-projected direct field. */
  protected override _directFieldsAsTypeIds(): TypeId[] {
    const out: TypeId[] = [];
    if (this.project_id) out.push(new TypeId('project', this.project_id));
    return out;
  }

  /** Always open conversations in the conversation view — every entry point
   *  (inbox, recent strip, chips, deep links) lands on the same URL. */
  override get dockPointer(): DockPointerData {
    if (!this.id) return new DockPointerData(ViewType.INBOX);
    return new DockPointerData(ViewType.CONVERSATION, this.id);
  }

  get conversationMessageIds(): ConversationMessagePointer[] {
    if (!this.message_ids) return [];
    let raw: RawConversationPointer[];
    try {
      raw = JSON.parse(this.message_ids) as RawConversationPointer[];
    } catch {
      return [];
    }
    const out: ConversationMessagePointer[] = [];
    for (const p of raw) {
      if (!p?.typeid || !p?.ts) continue;
      const dash = p.typeid.indexOf('-');
      if (dash <= 0) continue;
      out.push({ type: p.typeid.slice(0, dash), id: p.typeid.slice(dash + 1), ts: p.ts });
    }
    return out;
  }

  /**
   * Append a FlowMessage to this conversation. Hits the standard graph
   * action ``POST /api/v1/graph/conversation/<id>/add_message``; the local
   * backend forwards to the hub. Returns the persisted FlowMessage JSON.
   *
   * ``attachment``: optional list of Attachment-shaped entries. When at
   * least one entry requires a body bundle (FILE / PROMPT-with-file /
   * TYPE_ID) the hub stamps ``body_status=UPLOADING`` on the FM and the
   * caller is expected to fire ``fm.uploadBody()`` in the background.
   */
  async addMessage(
    text: string,
    opts: {
      sender_name?: string;
      attachment?: unknown[];
      context_entities?: unknown[];
    } = {},
  ): Promise<IFlowMessage> {
    const action = new ActionInfo('add_message', this.typeId.type, this.typeId.id, 'POST');
    action.bodyParameters = {
      text,
      ...(opts.sender_name ? { sender_name: opts.sender_name } : {}),
      ...(opts.attachment && opts.attachment.length > 0 ? { attachment: opts.attachment } : {}),
      ...(opts.context_entities && opts.context_entities.length > 0
        ? { context_entities: opts.context_entities }
        : {}),
    };
    const res = await dataManager.callAction<unknown, IFlowMessage>(action);
    return res!;
  }

  /**
   * Reactive subscription to FlowMessage activity on this conversation.
   *
   * Wraps APIEntity's event emitter so callers can write
   *   ``conv.on(ConversationEvents.MESSAGE, m => ...)`` — every inbound
   *     ``data_op_msg(create)`` flow_message whose ``conversation_id``
   *     matches ``this.id``;
   *   ``conv.on(ConversationEvents.ACK, m => ...)`` — every ``update``
   *     frame that carries a delivery_status change (a receipt) for one
   *     of this conversation's messages.
   * The tap is installed lazily on the first MESSAGE/ACK subscription and
   * torn down when the last listener unregisters.
   *
   * Returns an unsubscribe function (compatible with the base ``on``).
   */
  override on(eventType: string | string[], callback: Callable): () => void {
    const types = Array.isArray(eventType) ? eventType : [eventType];
    // The tap feeds both MESSAGE (inbound creates) and ACK (receipt
    // updates), so install it for either subscription.
    const needsTap =
      types.includes(ConversationEvents.MESSAGE) || types.includes(ConversationEvents.ACK);
    if (needsTap) {
      this._ensureMessageTap();
    }
    const baseOff = super.on(eventType, callback);
    return () => {
      baseOff();
      if (needsTap) {
        this._maybeTearDownMessageTap();
      }
    };
  }

  private _msgTapOff: (() => void) | null = null;

  private _ensureMessageTap(): void {
    if (this._msgTapOff) return;
    const cm = ConnectionManager.getInstance();
    const handler = (typeIdStr: string, op: string, data: any) => {
      const dash = typeIdStr.indexOf('-');
      if (dash <= 0) return;
      if (typeIdStr.slice(0, dash) !== FlowMessage.type) return;
      if (!data || data.conversation_id !== this.id) return;
      if (op === DataOp.CREATE) {
        this.emit(ConversationEvents.MESSAGE, data as IFlowMessage);
      } else if (op === DataOp.UPDATE && data.delivery_status != null) {
        // A receipt changed on one of this conversation's messages.
        this.emit(ConversationEvents.ACK, data as IFlowMessage);
      }
    };
    cm.on('on_data_op', handler);
    this._msgTapOff = () => cm.off('on_data_op', handler);
  }

  private _maybeTearDownMessageTap(): void {
    const listeners = (this as any)._eventListeners as Map<string, Callable[]>;
    // Keep the tap alive while either MESSAGE or ACK listeners remain.
    if (listeners.get(ConversationEvents.MESSAGE)?.length) return;
    if (listeners.get(ConversationEvents.ACK)?.length) return;
    this._msgTapOff?.();
    this._msgTapOff = null;
  }
}

export interface CreateProjectConversationParams {
  project_id: string;
  participants: ConversationParticipant[];
  /** Optional display name. Backend falls back to a participants summary when absent. */
  title?: string;
}

export interface CreateProjectConversationResult {
  conversation_id: string;
  project_id: string;
  participants: ConversationParticipant[];
  name?: string | null;
}

export async function createProjectConversation(
  params: CreateProjectConversationParams,
): Promise<CreateProjectConversationResult> {
  const action = new ActionInfo('conversation-create', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<CreateProjectConversationParams, CreateProjectConversationResult>(action);
  return res!;
}

// ---------------------------------------------------------------------------
// Cross-user conversations: bundle (.flowmsg) delivery, single codepath.
//
// Both task-bound shares (`share_task`) and homelanding-started conversations
// (`conversation-start-bundle`) use the same `.flowmsg` bundle pipeline. The
// recipient gets a pending Invitation linked to the share's first FlowMessage;
// on accept, the bundle downloads and the local Conversation materializes.
// ---------------------------------------------------------------------------

export interface StartBundleConversationParams {
  /** First remote participant. Kept for back-compat; prefer participants. */
  recipient_id?: string;
  /** Cross-user participants. user_id is the canonical key when known. */
  participants?: ConversationParticipant[];
  /** First message text. */
  message?: string;
  /** Display title; defaults to a truncated message preview when blank. */
  title?: string;
  /** Local Project this conversation is filed under (sender side). The bundle
   *  also stamps it as remote_project_id on the receiver for project mapping. */
  project_id?: string | null;
  project_name?: string | null;
  /** Display name on the first FlowMessage. Defaults to the local user's name. */
  sender_name?: string | null;
}

export interface StartBundleConversationResult {
  sent: boolean;
  email_error?: string | null;
  conversation_id?: string | null;
  task_id?: string | null;
  notification_id?: string | null;
  notify_url?: string | null;
}

/** Start a Task-less conversation via the bundle delivery path (Scenario B). */
export async function startBundleConversation(
  params: StartBundleConversationParams,
): Promise<StartBundleConversationResult> {
  const action = new ActionInfo('conversation-start-bundle', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<StartBundleConversationParams, StartBundleConversationResult>(action);
  return res!;
}

export interface SyncFromHubResult {
  invitations: number;
  flow_messages: number;
}

export interface FetchConversationsResult {
  /** Freshly-merged list of local Conversations after hub upsert. */
  conversations: unknown[];
  /** Conversation ids that triggered a background message fetch (hub had
   *  more messages than local). The actual messages arrive via WS frames. */
  bg_fetch_dispatched: string[];
  /** False when the hub call(s) failed (network/config). The local list
   *  is still returned so the UI can render from cache. */
  hub_reachable: boolean;
  /** True when the hub returned 401 — UI should open the LoginDialog. */
  auth_required: boolean;
}

/** Unified hub catch-up: pulls the conversation + invitation lists in
 *  parallel, upserts hub metadata locally, and dispatches per-conversation
 *  background message fetches keyed off ``message_count`` deltas. Returns
 *  fast (the merged list); new messages arrive via WS ``data_op_msg``
 *  frames as the background fetchers complete. */
export async function fetchConversations(): Promise<FetchConversationsResult> {
  const action = new ActionInfo('conversation-list', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, FetchConversationsResult>(action);
  return res ?? { conversations: [], bg_fetch_dispatched: [], hub_reachable: false, auth_required: false };
}

/** @deprecated Use {@link fetchConversations} instead. Kept as a one-release
 *  shim so existing UI call sites don't break in the same PR as the rename. */
export async function syncFromHub(): Promise<SyncFromHubResult> {
  const result = await fetchConversations();
  return {
    invitations: 0,
    flow_messages: result.bg_fetch_dispatched.length,
  };
}

export interface AcceptInvitationParams {
  invitation_id: string;
}

export interface AcceptInvitationResult {
  invitation_id: string;
  /** Id of the Conversation joined post-accept (direct-share invite flow). */
  conversation_id?: string | null;
  /** Id of the FlowMessage whose bundle was downloaded and unpacked, if any. */
  flow_message_id?: string | null;
  /** True when the targeted bundle download materialized the local Conversation. */
  bundle_unpacked: boolean;
}

export interface DismissConversationParams {
  conversation_id: string;
}

export interface DismissConversationResult {
  conversation_id: string;
  dismissed_at: string | null;
}

/** Strip-only dismiss: stamps ``dismissed_at = now()`` on the conversation so
 *  the Recent strip hides it. The row auto-revives when a FlowMessage newer
 *  than the stamp arrives. Inbox ignores this field. */
export async function dismissConversation(
  params: DismissConversationParams,
): Promise<DismissConversationResult> {
  const action = new ActionInfo('conversation-dismiss', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<DismissConversationParams, DismissConversationResult>(action);
  return res!;
}

export interface ArchiveConversationParams {
  conversation_id: string;
}

export interface ArchiveConversationResult {
  conversation_id: string;
  archived_at: string | null;
}

export interface ArchiveAllConversationsResult {
  archived: number;
  scanned: number;
  archived_at: string;
}

/** Conversation-level archive: stamps ``archived_at = now()``. Both Inbox
 *  and Recent strip hide the row when set; auto-revives when a FlowMessage
 *  newer than the stamp arrives. Per-message ``FlowMessage.is_read`` is
 *  independent and not touched. */
export async function archiveConversation(
  params: ArchiveConversationParams,
): Promise<ArchiveConversationResult> {
  const action = new ActionInfo('conversation-archive', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<ArchiveConversationParams, ArchiveConversationResult>(action);
  return res!;
}

/** Archive every conversation that isn't already archived. Skips already-
 *  archived rows server-side, so it stays cheap on repeat clicks. */
export async function archiveAllConversations(): Promise<ArchiveAllConversationsResult> {
  const action = new ActionInfo('conversation-archive-all', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, ArchiveAllConversationsResult>(action);
  return res!;
}

export interface DeleteArchivedConversationsResult {
  /** Ids of conversations that succeeded both hub-side and locally. */
  deleted: string[];
  /** Per-item failure (e.g. hub returned 403 on a non-owner row). */
  failed: { id: string; reason: string }[];
  /** Total number of archived rows considered. */
  scanned: number;
}

/** Bulk delete-archived: best-effort loop on the server. For each archived
 *  row, the server classifies the user's role and either calls the hub
 *  delete/leave/decline action or just deletes locally. Per-item status is
 *  returned so the caller can surface partial failures. */
export async function deleteArchivedConversations(): Promise<DeleteArchivedConversationsResult> {
  const action = new ActionInfo('conversation-delete-archived', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, DeleteArchivedConversationsResult>(action);
  return res!;
}

export type DeleteConversationMode = 'delete_for_all' | 'leave' | 'local';

export interface DeleteConversationParams {
  conversation_id: string;
  /** Caller picks the mode based on the user's relationship to the conv:
   *    - ``delete_for_all``: owner cascade-delete (rule 1)
   *    - ``leave``:          non-owner participant leaves (rule 3)
   *    - ``local``:          purely-local conv, no hub call (rule 2)
   */
  mode: DeleteConversationMode;
}

export interface DeleteConversationResult {
  id: string;
  mode: DeleteConversationMode;
}

/** Per-row conversation delete. The server calls the matching hub action
 *  for non-``local`` modes and hard-deletes the local row on success. */
export async function deleteConversation(
  params: DeleteConversationParams,
): Promise<DeleteConversationResult> {
  const action = new ActionInfo('conversation-delete', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<DeleteConversationParams, DeleteConversationResult>(action);
  return res!;
}

/** Thin alias: leave a shared conversation you don't own. */
export async function leaveConversation(
  params: { conversation_id: string },
): Promise<DeleteConversationResult> {
  return deleteConversation({ conversation_id: params.conversation_id, mode: 'leave' });
}

/** Accept a pending invitation on the hub and download just the unlocked bundle.
 *
 * Does NOT pull other accessible FlowMessages — that's the Refresh button's job
 * (``syncFromHub``). Keeps accept latency to ~one HTTP round-trip + one bundle
 * download.
 */
export async function acceptInvitation(
  params: AcceptInvitationParams,
): Promise<AcceptInvitationResult> {
  const action = new ActionInfo('invitation-accept', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<AcceptInvitationParams, AcceptInvitationResult>(action);
  return res!;
}
