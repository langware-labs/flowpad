import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export const local_domain = 'local.machine';
export interface IUser extends IEntity {
  name?: string;
  email?: string;
  picture?: string;
  last_login?: Date;
}

@registerEntity
export class User extends APIEntity<User> implements IUser {
  name?: string;
  email?: string;
  picture?: string;
  last_login?: Date;
  static type: string = 'user';

  constructor(entity: Partial<IUser> = {}) {
    super(entity);
    this.name = entity.name;
    this.email = entity.email;
    this.picture = entity.picture;
    this.last_login = entity.last_login;
  }

  get isLocal(): boolean {
    if (!this.email) {
      return false;
    }
    const domain = this.email.split('@')[1];
    return domain === local_domain;
  }
}
