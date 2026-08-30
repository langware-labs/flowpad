import type { EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IOrganization extends IEntity {
  name?: string;
  account?: string;
  domain?: string;
  icon?: string | null;
}

// `implements IOrganization` only checks the class; it contributes no members, so every
// field declared solely on IOrganization read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Organization extends EntityMerge<IOrganization, 'icon'> {}

@registerEntity
export class Organization extends APIEntity<Organization> implements IOrganization {
  static type: string = 'organization';
  name?: string;
  account?: string;
  domain?: string;

  constructor(entity: Partial<IOrganization> = {}) {
    super(entity);
    this.name = entity.name;
    this.account = entity.account;
    this.domain = entity.domain;
    this.icon = entity.icon;
  }
}
