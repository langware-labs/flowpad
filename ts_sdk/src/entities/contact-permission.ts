import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/** Capability strings stored in `ContactPermission.allowed_actions`. Mirrors
 *  `flow_sdk.builtin.contact_permission.PermissionAction`. */
export enum PermissionAction {
  /** Auto-run a received prompt. */
  EXECUTE_PROMPT = 'execute_prompt',
  /** Send the captured reply instead of saving it as a draft. */
  AUTO_REPLY = 'auto_reply',
}

export interface IContactPermission extends IEntity {
  /** Cross-machine-stable contact key (a FlowMessage sender_id is a user id). */
  contact_user_id?: string | null;
  /** Human-stable fallback key. */
  contact_email?: string | null;
  /** null = global (all projects); else scoped to this local project id. */
  project_id?: string | null;
  /** Granted capabilities (`PermissionAction` values). */
  allowed_actions?: string[];
}

/**
 * The receiver's LOCAL policy for what a remote contact may do with prompts
 * they send: auto-run them and/or auto-send the reply. Keyed by (contact,
 * project); a `project_id` of null means global. Never synced to the hub.
 */
@registerEntity
export class ContactPermission
  extends APIEntity<ContactPermission>
  implements IContactPermission
{
  contact_user_id?: string | null;
  contact_email?: string | null;
  project_id?: string | null;
  allowed_actions?: string[];
  static type: string = 'contact_permission';

  constructor(entity: Partial<IContactPermission> = {}) {
    super(entity);
    this.contact_user_id = entity.contact_user_id ?? null;
    this.contact_email = entity.contact_email ?? null;
    this.project_id = entity.project_id ?? null;
    this.allowed_actions = entity.allowed_actions ?? [];
  }
}
