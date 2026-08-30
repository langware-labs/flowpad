import type { EntityMerge } from '../IEntity';
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
  /** The recorded FlowpadDiagnosis this card is about; powers the feed View
   *  button. Present on every diagnosis card (issue and clean-sweep alike). */
  diagnosis_id?: string | null;
  /** Card variant: "" = diagnosis (Report/Forward), "draft_reply" = a draft
   *  reply waiting to send (Send/Open). */
  kind?: string;
}

// `implements IMessageSuggest` only checks the class; it contributes no members, so every
// field declared solely on IMessageSuggest read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageSuggest extends EntityMerge<IMessageSuggest> {}

@registerEntity
export class MessageSuggest extends APIEntity<MessageSuggest> implements IMessageSuggest {
  static type: string = 'message_suggest';
  text?: string;
  message_text?: string;
  conversation_id?: string | null;
  flow_message_id?: string | null;
  diagnosis_id?: string | null;
  kind?: string;

  constructor(entity: Partial<IMessageSuggest> = {}) {
    super(entity);
    this.text = entity.text;
    this.message_text = entity.message_text;
    this.conversation_id = entity.conversation_id ?? null;
    this.flow_message_id = entity.flow_message_id ?? null;
    this.diagnosis_id = entity.diagnosis_id ?? null;
    this.kind = entity.kind;
  }

  override getDisplayName(): string | null {
    return this.text?.trim() || null;
  }
}
