import { IEntity } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';

export interface IVisitor extends IEntity {
  ga_client_id?: string | null;
  utm_params?: Record<string, string> | null;
  visitor_role?: string;
}

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
