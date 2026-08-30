import { APIEntity, dataManager, registerEntity, type EntityMember } from '../APIEntity';
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
/**
 * The newest pointer by `ts`, or null for an empty list. Exported so the
 * surfaces that hold a raw pointer array (the inbox list, the recent strip)
 * all share one rule — there must be exactly one definition of "latest" in
 * the app, and it must agree with `Conversation.latest_message_ref()` on the
 * backend, which computes the unread BADGE while this computes the unread ROW.
 *
 * Unparseable timestamps sort oldest, so a corrupt entry can never win.
 */
export function latestPointer(
  pointers: readonly ConversationMessagePointer[] | undefined | null,
): ConversationMessagePointer | null {
  let best: ConversationMessagePointer | null = null;
  let bestAt = -Infinity;
  for (const p of pointers ?? []) {
    const at = Date.parse(p.ts);
    const rank = Number.isNaN(at) ? -Infinity : at;
    if (best === null || rank > bestAt) {
      best = p;
      bestAt = rank;
    }
  }
  return best;
}

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
  role?: string | null;
  /** Open like `EntityMember`, which this must stay assignable to: extra hub
   *  keys (`status`, `invitation_id`, …) pass through untouched. Without it
   *  Conversation fails its own `APIEntity<Conversation>` constraint. */
  [key: string]: unknown;
}

/** Mirrors ``flow_sdk.builtin.conversation.ConversationKind`` exactly.
 *  ``helpdesk`` marks a support ticket whose responder identity is masked
 *  behind the project's ``helpdesk.display_name``. Hub-authoritative — never
 *  set client-side. */
export enum ConversationKind {
  DIRECT = 'direct',
  HELPDESK = 'helpdesk',
}

/** True when `kind` denotes a helpdesk ticket. */
export function isHelpdeskKind(kind?: ConversationKind | string | null): boolean {
  return kind === ConversationKind.HELPDESK;
}

export interface IConversation extends IEntity {
  /** How this conversation is interpreted. Defaults to ``direct``; the hub sets
   *  ``helpdesk`` for guest-opened support tickets. */
  kind?: ConversationKind;
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
  /** Hub role roster — inherited from the Entity base as ``members``. The wire
   *  key on the conversation fanout is ``participants`` (hub contract), adapted
   *  in ``onEntityUpdate``. */
  /** User-set display title. Set at creation in NewConversationDialog and
   *  shipped through the bundle on cross-user send. */
  title?: string | null;
  /**
   * Conversation-scoped default transfer mode for asset shares. When true, asset
   * shares into this conversation ride as Git-origin metadata (the receiver
   * clones/pulls on an explicit Download) instead of copied bytes. Hub-synced and
   * inherited by later replies from either side; defaults false (copy). The
   * sender opts in per conversation via the Share dialog's Git toggle.
   */
  git_sharing_enabled?: boolean;
  /** Strip-only dismissal timestamp. Recent strip hides the row when set;
   *  auto-revives when a FlowMessage newer than this stamp arrives. Inbox
   *  ignores this field. Null = not dismissed. */
  dismissed_at?: string | Date | null;
  /** Conversation-level archive timestamp. Both Inbox and Recent strip hide
   *  the row when set; auto-revives when a FlowMessage newer than this stamp
   *  arrives. Per-message ``FlowMessage.is_read`` remains independent. */
  archived_at?: string | Date | null;
}

/**
 * Declaration merge: `implements IConversation` only CHECKS the class, it adds no
 * members — so every field declared solely on IConversation read as "does not exist
 * on type Conversation", even though `deepAssign` populates them from the wire.
 * This interface makes them part of the class type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Conversation extends Omit<IConversation, 'expand' | 'id' | 'is_private' | 'members'> {}

@registerEntity
export class Conversation extends APIEntity<Conversation> implements IConversation {
  kind?: ConversationKind;
  project_id?: string | null;
  remote_project_id?: string | null;
  remote_project_name?: string | null;
  message_count?: number;
  message_ids?: string | null;
  // ``members`` (the hub role roster) is inherited from the Entity base.
  title?: string | null;
  git_sharing_enabled?: boolean;
  dismissed_at?: string | Date | null;
  archived_at?: string | Date | null;
  static type: string = 'conversation';

  constructor(entity: Partial<IConversation> = {}) {
    super(entity);
    this.kind = entity.kind ?? ConversationKind.DIRECT;
    this.project_id = entity.project_id;
    this.remote_project_id = entity.remote_project_id;
    this.remote_project_name = entity.remote_project_name;
    this.message_count = entity.message_count;
    this.message_ids = entity.message_ids;
    this.title = entity.title;
    this.git_sharing_enabled = entity.git_sharing_enabled ?? false;
    this.dismissed_at = entity.dismissed_at ?? null;
    this.archived_at = entity.archived_at ?? null;
  }

  /**
   * A conversation's user-facing label is its `title` (set at creation, edited
   * in the header, renamed via the hub). `name` is a generated
   * `conversation-<id>` placeholder, so the generic `defaultDisplayName` chain
   * (which ranks `name` first) would surface the id. Override to prefer `title`;
   * returning null when untitled defers to the chain (→ name / participants).
   * This is what makes the tab chip — and every `displayName` consumer — read
   * the subject instead of the placeholder.
   */
  getDisplayName(): string | null {
    return this.title?.trim() || null;
  }

  /**
   * Called by the store when the backend pushes an entity update
   * (castAndDeepAssign runs this hook, then deepAssign on what's left).
   *
   * The roster (``members``) is a full server-authoritative snapshot — it must
   * REPLACE, not merge. ``deepAssign`` recurses into arrays and merges them by
   * index, never shrinking the target, so a member leaving would leave a stale
   * tail entry ([A,B] + wire [B] → [B,B]). Assign the wire value wholesale here
   * and strip it from the payload so the following deepAssign skips it. (Same
   * pattern AgenticProcess uses for ``queue``.)
   *
   * Wire adapter: the local backend serializes the roster as ``members``; the
   * hub conversation fanout uses ``participants`` (hub contract). Accept either
   * key and land it on ``members``.
   * @internal
   */
  protected onEntityUpdate(data: Partial<IConversation> & { participants?: unknown }): void {
    const key = 'members' in data ? 'members' : 'participants' in data ? 'participants' : null;
    if (key) {
      const roster = (data as Record<string, unknown>)[key];
      this.members = Array.isArray(roster)
        ? roster.map((p) => ({ ...(p as EntityMember) }))
        : (roster as EntityMember[] | undefined);
      delete (data as Record<string, unknown>)[key];
    }
  }

  // NOTE: FE-side project chip projection moved server-side. The backend's
  // ``Entity.get_implicit_private_context_entities`` projects project_id
  // for every entity that has one; the merged ``private_context_entities``
  // arrives over the wire ready to render.

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
      shared_context_entities?: unknown[];
    } = {},
  ): Promise<IFlowMessage> {
    const action = new ActionInfo('add_message', this.typeId.type, this.typeId.id, 'POST');
    action.bodyParameters = {
      text,
      ...(opts.sender_name ? { sender_name: opts.sender_name } : {}),
      ...(opts.attachment && opts.attachment.length > 0 ? { attachment: opts.attachment } : {}),
      ...(opts.shared_context_entities && opts.shared_context_entities.length > 0
        ? { shared_context_entities: opts.shared_context_entities }
        : {}),
    };
    const res = await dataManager.callAction<unknown, IFlowMessage>(action);
    return res!;
  }

  /**
   * Rename a (shared) conversation. Issues the generic entity update
   * (``PUT /api/v1/graph/conversation/<id>`` with ``{title}``) and opts the call
   * into hub reflection, so for a ``remote`` conversation the local backend
   * forwards the rename to the hub, which fans the title update to the other
   * participants. Set ``overWs`` to send the update over the WebSocket
   * (``rest_api_msg``) instead of HTTP — both paths reflect identically.
   */
  async rename(title: string, opts: { overWs?: boolean } = {}): Promise<void> {
    const action = new ActionInfo('update', this.typeId.type, this.typeId.id, 'PUT');
    action.bodyParameters = { title };
    action.hubReflect = true;
    if (opts.overWs) {
      await dataManager.callActionOverWS<unknown, unknown>(action);
    } else {
      await dataManager.callAction<unknown, unknown>(action);
    }
    this.title = title;
  }

  /**
   * Set the conversation-scoped ``git_sharing_enabled`` default (asset shares
   * ride Git-origin metadata when true, copied bytes when false). Same transport
   * as {@link rename}: the generic entity update (``PUT /graph/conversation/<id>``
   * with ``{git_sharing_enabled}``) opted into hub reflection, so for a shared
   * (``remote``) conversation the local backend forwards it to the hub, which
   * persists the authoritative value; the peer's local mirror converges on its
   * next conversation-list sync (``_upsert_hub_conversation_metadata``). Any
   * participant may flip it — the latest submitted value wins.
   */
  async setGitSharingEnabled(enabled: boolean): Promise<void> {
    const action = new ActionInfo('update', this.typeId.type, this.typeId.id, 'PUT');
    action.bodyParameters = { git_sharing_enabled: enabled };
    action.hubReflect = true;
    await dataManager.callAction<unknown, unknown>(action);
    this.git_sharing_enabled = enabled;
  }

  /**
   * Fan out an "install in project" pick to the whole conversation: install
   * EVERY attachment of this conversation into ``projectId``. Backs binding a
   * conversation to a project so all its current assets (and, via the reception
   * path, future arrivals) become project assets. Receiver-local — no
   * hub-reflect. Returns the per-attachment outcome buckets.
   */
  async installAttachmentsIntoProject(
    projectId: string,
  ): Promise<{ installed: string[]; skipped: string[]; failed: string[] }> {
    const action = new ActionInfo('install-attachments', this.typeId.type, this.typeId.id, 'POST');
    action.bodyParameters = { project_id: projectId };
    const res = await dataManager.callAction<
      unknown,
      { installed: string[]; skipped: string[]; failed: string[] }
    >(action);
    return {
      installed: res?.installed ?? [],
      skipped: res?.skipped ?? [],
      failed: res?.failed ?? [],
    };
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
    const handler = (typeIdStr: string, op: string, data: any, fromEntityStr?: string | null) => {
      // child_created addressed to THIS conversation: the envelope is inverted,
      // so the type check below would reject it (typeIdStr is the conversation,
      // not the message). A synced message arrives this way — the local
      // catch-up announces it as a child of its parent — so without this branch
      // `conv.on('message')` never fires for anything pulled in a sync.
      if (op === DataOp.CHILD_CREATED) {
        if (typeIdStr !== this.typeId.toString()) return;
        const childType = (fromEntityStr ?? '').split('-')[0];
        if (childType && childType !== FlowMessage.type) return;
        if (data) this.emit(ConversationEvents.MESSAGE, data as IFlowMessage);
        return;
      }
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

export type CreateProjectConversationParams = {
  project_id: string;
  participants: ConversationParticipant[];
  /** Optional display name. Backend falls back to a participants summary when absent. */
  title?: string;
  /** Serialized TypeIds (e.g. ``"markdown-<uuid>"``) shared into this
   *  conversation. The backend DERIVES the owning project from the first one
   *  that has a project, falling back to ``project_id`` (the ambient default)
   *  when none resolves — so the project follows the shared entity, not the
   *  client's active project. */
  shared_context_entities?: string[];
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

export interface StartHelpdeskTicketResult {
  conversation_id: string;
  project_id: string;
}

/** Open a support ticket: a guest-authored ``helpdesk`` conversation under the
 *  resolved helpdesk project (resolved server-side from ``/version``). The
 *  backend routes through the hub and materializes the conversation locally,
 *  then returns its id for navigation. Requires cloud login. */
export async function startHelpdeskTicket(
  text: string,
  projectId?: string | null,
): Promise<StartHelpdeskTicketResult> {
  const action = new ActionInfo('helpdesk-start-ticket', null, null, 'POST');
  action.bodyParameters = { text, project_id: projectId ?? '' };
  const res = await dataManager.callAction<
    { text: string; project_id: string },
    StartHelpdeskTicketResult
  >(action);
  return res!;
}

/** Staff-side: pick up (join) a helpdesk ticket so the caller receives its
 *  messages and can reply. Proxies to the hub ``pickup`` action and syncs the
 *  conversation locally. */
export async function pickupConversation(conversationId: string): Promise<{ conversation_id: string }> {
  const action = new ActionInfo('conversation-pickup', null, null, 'POST');
  action.bodyParameters = { conversation_id: conversationId };
  const res = await dataManager.callAction<{ conversation_id: string }, { conversation_id: string }>(action);
  return res!;
}

/** One row in the staff helpdesk triage queue (lightweight; not a full
 *  Conversation entity). Sourced from the hub via the helpdesk project. */
export interface HelpdeskTicket {
  conversation_id: string;
  title?: string | null;
  /** First-message text, truncated. */
  preview: string;
  /** Guest (ticket opener) hub user id. */
  initiated_by?: string | null;
  message_count: number;
  participant_count: number;
  /** True when the calling staff user is already on the roster. */
  picked_up: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ListHelpdeskTicketsResult {
  tickets: HelpdeskTicket[];
  project_id: string;
}

/** Staff triage queue: list the helpdesk project's tickets, including ones the
 *  caller hasn't picked up (which don't otherwise appear in their inbox).
 *  Members-only on the hub. */
/**
 * Tickets for a desk. Two callers, opposite questions:
 *
 * - a REQUESTER passes `projectId` — "which desk serves the project I'm in?"
 * - STAFF pass `deskProjectId` — "what is queued on MY desk?" — and it is used
 *   verbatim.
 *
 * Staff need the second form: a desk owner's own project has no desk of its
 * own, so resolving from it walks past their queue to whatever desk serves
 * *them*, and the hub rejects them as a guest on someone else's desk.
 */
export async function listHelpdeskTickets(
  projectId?: string | null,
  deskProjectId?: string | null,
): Promise<ListHelpdeskTicketsResult> {
  const action = new ActionInfo('helpdesk-tickets-list', null, null, 'POST');
  action.bodyParameters = {
    project_id: projectId ?? '',
    desk_project_id: deskProjectId ?? '',
  };
  const res = await dataManager.callAction<
    { project_id: string; desk_project_id: string },
    ListHelpdeskTicketsResult
  >(action);
  return res ?? { tickets: [], project_id: '' };
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

export type AcceptInvitationParams = {
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

export type DismissConversationParams = {
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

export type ArchiveConversationParams = {
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

/** Conversation-level unarchive: clears ``archived_at`` (back to null). The
 *  manual inverse of archive — the same effect the auto-revive achieves when a
 *  newer FlowMessage arrives. Local-only, like archive (the hub never sees
 *  ``archived_at``). */
export async function unarchiveConversation(
  params: ArchiveConversationParams,
): Promise<ArchiveConversationResult> {
  const action = new ActionInfo('conversation-unarchive', null, null, 'POST');
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

export type DeleteConversationParams = {
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
