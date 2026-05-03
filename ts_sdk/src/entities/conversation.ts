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

export interface ConversationMessagePointer {
  message_id: string;
  timestamp: string;
}

export interface ConversationParticipant {
  user_id?: string | null;
  email: string;
  name?: string | null;
}

export interface IConversation extends IEntity {
  project_id?: string | null;
  data_path?: string | null;
  message_count?: number;
  message_ids?: string | null;  // JSON-encoded ConversationMessagePointer[]
  participants?: ConversationParticipant[];
  // NOTE: task_id moved into context_entities. Use conv.firstContextOfType('task').
}

@registerEntity
export class Conversation extends APIEntity<Conversation> implements IConversation {
  project_id?: string | null;
  data_path?: string | null;
  message_count?: number;
  message_ids?: string | null;
  participants?: ConversationParticipant[];
  static type: string = 'conversation';

  constructor(entity: Partial<IConversation> = {}) {
    super(entity);
    this.project_id = entity.project_id;
    this.data_path = entity.data_path;
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
    try {
      return JSON.parse(this.message_ids) as ConversationMessagePointer[];
    } catch {
      return [];
    }
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
}

export interface CreateHubConversationResult {
  conversation_id: string;
  invitations: Array<{ id: string; recipient_email: string }>;
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
