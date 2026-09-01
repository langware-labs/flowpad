import { IEntity, EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';

export interface IMention extends IEntity {
  mentioned_by_id?: string;
  mentioned_user_id?: string;
  mentioned_in_entity_type?: string;
  mentioned_in_entity_id?: string;
  target_url_path?: string;
  sent?: boolean;
}

// `implements IMention` only checks the class; it contributes no members, so every
// field declared solely on IMention read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Mention extends EntityMerge<IMention> {}

@registerEntity
export class Mention extends APIEntity<Mention> implements IMention {
  mentioned_by_id?: string;
  mentioned_user_id?: string;
  mentioned_in_entity_type?: string;
  mentioned_in_entity_id?: string;
  target_url_path?: string;
  sent: boolean = false;
  static type: string = 'mention';

  constructor(entity: Partial<IMention> = {}) {
    super(entity);
    this.mentioned_by_id = entity.mentioned_by_id;
    this.mentioned_user_id = entity.mentioned_user_id;
    this.mentioned_in_entity_type = entity.mentioned_in_entity_type;
    this.mentioned_in_entity_id = entity.mentioned_in_entity_id;
    this.target_url_path = entity.target_url_path;
    this.sent = entity.sent ?? false;
  }
}
