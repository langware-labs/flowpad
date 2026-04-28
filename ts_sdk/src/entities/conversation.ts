import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
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

export interface IConversation extends IEntity {
  task_id?: string | null;
  project_id?: string | null;
  data_path?: string | null;
  message_count?: number;
  message_ids?: string | null;  // JSON-encoded ConversationMessagePointer[]
}

@registerEntity
export class Conversation extends APIEntity<Conversation> implements IConversation {
  task_id?: string | null;
  project_id?: string | null;
  data_path?: string | null;
  message_count?: number;
  message_ids?: string | null;
  static type: string = 'conversation';

  constructor(entity: Partial<IConversation> = {}) {
    super(entity);
    this.task_id = entity.task_id;
    this.project_id = entity.project_id;
    this.data_path = entity.data_path;
    this.message_count = entity.message_count;
    this.message_ids = entity.message_ids;
  }

  /**
   * If this conversation is scoped to a project, deep-link into the project view
   * with the conversation tab open. Otherwise, open the inbox focused on this
   * conversation via query params (?conversation=<id>).
   */
  override get dockPointer(): DockPointerData {
    if (this.project_id && this.id) {
      return new DockPointerData(ViewType.PROJECT, `${this.project_id}/conversation/${this.id}`);
    }
    if (this.id) {
      return new DockPointerData(ViewType.INBOX, undefined, { conversation: this.id });
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
