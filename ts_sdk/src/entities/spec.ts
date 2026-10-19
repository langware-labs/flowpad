import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

export interface ISpec extends IEntity {
  title?: string | null;
  content?: string | null;
  spec_type?: string | null;
  author_id?: string | null;
  // NOTE: plan_id moved into context_entities. Use spec.firstContextOfType('plan').
}

// `implements ISpec` only checks the class; it contributes no members, so every
// field declared solely on ISpec read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Spec extends EntityMerge<ISpec> {}

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

  // NOTE: author_id projection moved server-side. See
  // ``Entity.get_implicit_private_context_entities`` (Python) — base
  // projects only project_id; author_id was dropped per
  // "base returns project_id only for now". Add a Python-side override on
  // Spec if the author chip needs to come back.
}
