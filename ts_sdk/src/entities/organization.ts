import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IOrganization extends IEntity {
  name?: string;
  account?: string;
  domain?: string;
  icon?: string;
}

@registerEntity
export class Organization extends APIEntity<Organization> implements IOrganization {
  static type: string = 'organization';
  name?: string;
  account?: string;
  domain?: string;
  icon?: string;

  constructor(entity: Partial<IOrganization> = {}) {
    super(entity);
    this.name = entity.name;
    this.account = entity.account;
    this.domain = entity.domain;
    this.icon = entity.icon;
  }
}
