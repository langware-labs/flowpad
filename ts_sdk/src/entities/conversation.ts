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
  message_id: string;
  timestamp: string;
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
   * Project-scoped conversations still nest into the project tab so the
   * collaboration UI keeps its split layout, but standalone conversations
   * (inbox / shared-task) all land on the same conversation viewer.
   */
  override get dockPointer(): DockPointerData {
    if (this.project_id && this.id) {
      return new DockPointerData(ViewType.PROJECT, `${this.project_id}/conversation/${this.id}`);
    }
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
