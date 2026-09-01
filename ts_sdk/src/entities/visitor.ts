import { IEntity, EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';

export interface IVisitor extends IEntity {
  ga_client_id?: string | null;
  utm_params?: Record<string, string> | null;
  visitor_role?: string;
}

// `implements IVisitor` only checks the class; it contributes no members, so every
// field declared solely on IVisitor read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Visitor extends EntityMerge<IVisitor> {}

@registerEntity
export class Visitor extends APIEntity<Visitor> implements IVisitor {
  ga_client_id?: string | null;
  utm_params?: Record<string, string> | null;
  visitor_role?: string;
  static type: string = 'visitor';

  constructor(entity: Partial<IVisitor> = {}) {
    super(entity);
    this.ga_client_id = entity.ga_client_id;
    this.utm_params = entity.utm_params;
    this.visitor_role = entity.visitor_role;
  }
}
