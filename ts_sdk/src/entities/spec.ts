import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface ISpec extends IEntity {
  title?: string | null;
  content?: string | null;
  spec_type?: string | null;
  plan_id?: string | null;
  author_id?: string | null;
}

@registerEntity
export class Spec extends APIEntity<Spec> implements ISpec {
  title?: string | null;
  content?: string | null;
  spec_type?: string | null;
  plan_id?: string | null;
  author_id?: string | null;
  static type: string = 'spec';

  constructor(entity: Partial<ISpec> = {}) {
    super(entity);
    this.title = entity.title;
    this.content = entity.content;
    this.spec_type = entity.spec_type;
    this.plan_id = entity.plan_id;
    this.author_id = entity.author_id;
  }
}
