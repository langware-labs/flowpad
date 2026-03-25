import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IWorkspace extends IEntity {
  name?: string;
  namespace?: string;
}

@registerEntity
export class Workspace extends APIEntity<Workspace> implements IWorkspace {
  static type: string = 'workspace';
  name?: string;
  namespace?: string;

  constructor(entity: Partial<IWorkspace> = {}) {
    super(entity);
    this.name = entity.name;
    this.namespace = entity.namespace;
  }
}
