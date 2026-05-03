import { APIEntity, registerEntity } from '../APIEntity';
import { TypeId } from '../models/TypeId';
import { IEntity } from '../IEntity';

export interface ISpec extends IEntity {
  title?: string | null;
  content?: string | null;
  spec_type?: string | null;
  author_id?: string | null;
  // NOTE: plan_id moved into context_entities. Use spec.firstContextOfType('plan').
}

@registerEntity
export class Spec extends APIEntity<Spec> implements ISpec {
  title?: string | null;
  content?: string | null;
  spec_type?: string | null;
  author_id?: string | null;
  static type: string = 'spec';

  constructor(entity: Partial<ISpec> = {}) {
    super(entity);
    this.title = entity.title;
    this.content = entity.content;
    this.spec_type = entity.spec_type;
    this.author_id = entity.author_id;
  }

  /** Surface the author user as a chip-projected direct field. */
  protected override _directFieldsAsTypeIds(): TypeId[] {
    const out: TypeId[] = [];
    if (this.author_id) out.push(new TypeId('user', this.author_id));
    return out;
  }
}
