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

  /**
   * Users without a ``name`` are typically identified by their ``email``
   * (sign-in identifier). Fall back to email when name is empty so chat
   * bubbles and member lists show ``alice@example.com`` rather than
   * ``user-04…2b``. Returns null to defer to the default chain otherwise.
   */
  override getDisplayName(): string | null {
    if (this.name && this.name.trim()) return null;
    if (this.email && this.email.trim()) return this.email;
    return null;
  }

  get isLocal(): boolean {
    if (!this.email) {
      return false;
    }
    const domain = this.email.split('@')[1];
    return domain === local_domain;
  }
}
