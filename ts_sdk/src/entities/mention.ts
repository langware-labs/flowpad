import { IEntity } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';

export interface IMention extends IEntity {
  mentioned_by_id?: string;
  mentioned_user_id?: string;
  mentioned_in_entity_type?: string;
  mentioned_in_entity_id?: string;
  target_url_path?: string;
  sent?: boolean;
}

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
