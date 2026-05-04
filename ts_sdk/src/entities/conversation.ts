import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { ViewType } from '../utils/ui/view-types';

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
  email: string;
  name?: string | null;
}

export interface IConversation extends IEntity {
  project_id?: string | null;
  message_count?: number;
  message_ids?: string | null;  // JSON-encoded RawConversationPointer[]
  participants?: ConversationParticipant[];
  // NOTE: task_id moved into context_entities. Use conv.firstContextOfType('task').
  // NOTE: data_path is derived from the canonical records-data path on the
  // server — not exposed as a stored field anymore.
}

@registerEntity
export class Conversation extends APIEntity<Conversation> implements IConversation {
  project_id?: string | null;
  message_count?: number;
  message_ids?: string | null;
  participants?: ConversationParticipant[];
  static type: string = 'conversation';

  constructor(entity: Partial<IConversation> = {}) {
    super(entity);
    this.project_id = entity.project_id;
    this.message_count = entity.message_count;
    this.message_ids = entity.message_ids;
    this.participants = entity.participants;
  }

  /** Surface the project as a chip-projected direct field. */
  protected override _directFieldsAsTypeIds(): TypeId[] {
    const out: TypeId[] = [];
    if (this.project_id) out.push(new TypeId('project', this.project_id));
    return out;
  }

  /**
   * Deep-link to the dedicated conversation view at `/dock/conversation/<id>`.
   *
   * The previous "project-nested" form (`/dock/project/<projectId>/conversation/<id>`)
   * broke for cross-user conversations: the receiver doesn't have the sender's
   * Project entity locally, so the project loader 404s before the route
   * renders. The standalone form resolves the task + project from the
   * conversation itself and works on both sides.
   */
  override get dockPointer(): DockPointerData {
    if (this.id) {
      return new DockPointerData(ViewType.CONVERSATION, this.id);
    }
    return new DockPointerData(ViewType.INBOX);
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
// Hub-mirrored conversations (Entity.remote === true).
// ---------------------------------------------------------------------------

export interface HubConversationParticipantInput {
  /** Either the hub user id (when address_type='id') or an email address. */
  address: string;
  address_type: 'id' | 'email';
}

export interface CreateHubConversationParams {
  participants: HubConversationParticipantInput[];
  /** First message text. */
  initial_text?: string;
  title?: string;
  /** Display name on the first FlowMessage. Defaults server-side to the
   * local user's name (synced from `git config user.name`). */
  sender_name?: string | null;
}

export interface CreateHubConversationResult {
  conversation_id: string;
  invited_emails: string[];
}

/** Create a conversation that lives on the hub and is mirrored locally with `remote=true`. */
export async function createHubConversation(
  params: CreateHubConversationParams,
): Promise<CreateHubConversationResult> {
  const action = new ActionInfo('conversation-start-hub', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<CreateHubConversationParams, CreateHubConversationResult>(action);
  return res!;
}

export interface SyncFromHubResult {
  invitations: number;
  conversations: number;
  flow_messages: number;
}

/** Pull pending invitations + accessible conversations from the hub. */
export async function syncFromHub(): Promise<SyncFromHubResult> {
  const action = new ActionInfo('conversation-sync', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, SyncFromHubResult>(action);
  return res!;
}

export interface AddRemoteMessageParams {
  conversation_id: string;
  text: string;
}

export interface AddRemoteMessageResult {
  flow_message_id: string | null;
  conversation_id: string;
}

/** Add a message to a hub-mirrored conversation. */
export async function addRemoteMessage(
  params: AddRemoteMessageParams,
): Promise<AddRemoteMessageResult> {
  const action = new ActionInfo('conversation-add-remote-message', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<AddRemoteMessageParams, AddRemoteMessageResult>(action);
  return res!;
}

export interface AcceptInvitationParams {
  invitation_id: string;
}

export interface AcceptInvitationResult {
  invitation_id: string;
  synced: SyncFromHubResult;
}

/** Accept a pending invitation on the hub, then sync to materialize the conversation. */
export async function acceptInvitation(
  params: AcceptInvitationParams,
): Promise<AcceptInvitationResult> {
  const action = new ActionInfo('invitation-accept', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<AcceptInvitationParams, AcceptInvitationResult>(action);
  return res!;
}
