import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IMessageSuggest extends IEntity {
  /** User-facing header line. */
  text?: string;
  /** Summary body, so the card renders without a follow-up fetch. */
  message_text?: string;
  /** The support conversation this entry points at; issue cards only. */
  conversation_id?: string | null;
  /** The summary FlowMessage in that conversation; issue cards only. */
  flow_message_id?: string | null;
}

@registerEntity
export class MessageSuggest extends APIEntity<MessageSuggest> implements IMessageSuggest {
  static type: string = 'message_suggest';
  text?: string;
  message_text?: string;
  conversation_id?: string | null;
  flow_message_id?: string | null;

  constructor(entity: Partial<IMessageSuggest> = {}) {
    super(entity);
    this.text = entity.text;
    this.message_text = entity.message_text;
    this.conversation_id = entity.conversation_id ?? null;
    this.flow_message_id = entity.flow_message_id ?? null;
  }

  override getDisplayName(): string | null {
    return this.text?.trim() || null;
  }
}
