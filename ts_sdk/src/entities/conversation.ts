import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';

export interface ConversationMessage {
  role: string;       // "sender" | "recipient" | "bot"
  content: string;
  sender_id: string;
  timestamp: string;
}

export interface ConversationMessagePointer {
  /** Sender's local FlowMessage id — what the unpacked bundle materializes locally. */
  message_id: string;
  timestamp: string;
  /**
   * Hub-side id for this message, set by the sender after a successful hub
   * upload. Lets a receiver who skipped earlier deliveries (e.g. opened msg
   * #5 directly without unpacking #3 and #4) call `inbox-open(hub_id)` to
   * pull just the missing entities — without re-shipping every prior message
   * inside the bundle.
   */
  hub_id?: string;
}

export interface ConversationParticipant {
  user_id?: string | null;
  email: string;
  name?: string | null;
}

export interface IConversation extends IEntity {
  task_id?: string | null;
  project_id?: string | null;
  data_path?: string | null;
  message_count?: number;
  message_ids?: string | null;  // JSON-encoded ConversationMessagePointer[]
  participants?: ConversationParticipant[];
}

@registerEntity
export class Conversation extends APIEntity<Conversation> implements IConversation {
  task_id?: string | null;
  project_id?: string | null;
  data_path?: string | null;
  message_count?: number;
  message_ids?: string | null;
  participants?: ConversationParticipant[];
  static type: string = 'conversation';

  constructor(entity: Partial<IConversation> = {}) {
    super(entity);
    this.task_id = entity.task_id;
    this.project_id = entity.project_id;
    this.data_path = entity.data_path;
    this.message_count = entity.message_count;
    this.message_ids = entity.message_ids;
    this.participants = entity.participants;
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
}

export interface CreateProjectConversationResult {
  conversation_id: string;
  project_id: string;
  participants: ConversationParticipant[];
}

export async function createProjectConversation(
  params: CreateProjectConversationParams,
): Promise<CreateProjectConversationResult> {
  const action = new ActionInfo('conversation-create', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<CreateProjectConversationParams, CreateProjectConversationResult>(action);
  return res!;
}
