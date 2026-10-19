import { APIEntity, isNonEmptyString, registerEntity } from '../APIEntity';
import { EntityMerge } from '../IEntity';
import { IUser } from './user-types';
export type * from './user-types';

export const local_domain = 'local.machine';

// `implements IUser` only checks the class; it contributes no members, so every
// field declared solely on IUser read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface User extends EntityMerge<IUser> {}

@registerEntity
export class User extends APIEntity<User> implements IUser {
  name?: string;
  email?: string;
  picture?: string;
  user_id?: string;
  last_login?: Date;
  organization_id?: string;
  organization_role?: string;
  onboarded?: boolean;
  static type: string = 'user';

  constructor(entity: Partial<IUser> = {}) {
    super(entity);
    this.name = entity.name;
    this.email = entity.email;
    this.picture = entity.picture;
    this.user_id = entity.user_id;
    this.last_login = entity.last_login;
    this.organization_id = entity.organization_id;
    this.organization_role = entity.organization_role;
    this.onboarded = entity.onboarded;
  }

  /**
   * Users without a ``name`` are typically identified by their ``email``
   * (sign-in identifier). Fall back to email when name is empty so chat
   * bubbles and member lists show ``alice@example.com`` rather than
   * ``user-04…2b``. Returns null to defer to the default chain otherwise.
   */
  override getDisplayName(): string | null {
    if (isNonEmptyString(this.name)) return null;
    if (isNonEmptyString(this.email)) return this.email;
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
