/**
 * The wire shape of a user row, separate from the User class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';

export interface IUser extends IEntity {
  name?: string;
  email?: string;
  picture?: string;
  /**
   * Foreign hub/cloud identity of a contact, distinct from the local entity
   * ``id``. Lets a contact exist by hub id with no email. The local desktop
   * user leaves this undefined (its own ``id`` is authoritative).
   */
  user_id?: string;
  last_login?: Date;
  /** Optional cloud organization the user belongs to (hub-authoritative). */
  organization_id?: string;
  /** The user's role on that organization. Defaults to "member". */
  organization_role?: string;
  /** Whether the user finished onboarding. Backend `onboarded: bool` (default
   *  false) — see `flow_sdk/builtin/user.py`. */
  onboarded?: boolean;
}
