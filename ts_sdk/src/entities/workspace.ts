import { APIEntity, registerEntity } from '../APIEntity';
import { EntityTypes } from '../schema/types';
import { EntityMerge } from '../IEntity';
import { IWorkspace } from './workspace-types';
export type * from './workspace-types';

// `implements IWorkspace` only checks the class; it contributes no members, so every
// field declared solely on IWorkspace read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Workspace extends EntityMerge<IWorkspace> {}

@registerEntity
export class Workspace extends APIEntity<Workspace> implements IWorkspace {
  static type: string = EntityTypes.Workspace;
  name?: string;
  namespace?: string;

  constructor(entity: Partial<IWorkspace> = {}) {
    super(entity);
    this.name = entity.name;
    this.namespace = entity.namespace;
  }
}
