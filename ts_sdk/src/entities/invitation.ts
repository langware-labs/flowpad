import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

export interface IInvitation extends IEntity {
  recipient_email?: string;
  target_url_path?: string;
  accepted?: boolean;
  expiration_at?: string | Date;
  sent?: boolean;
  message?: string;
  // Membership invitations (organization / team / workspace / project) carry
  // a target descriptor instead of a backing conversation, so the inbox
  // renders a membership row.
  target_type?: string;
  target_id?: string;
  target_name?: string;
  target_role?: string;
  /** The inviter (resolved hub-side from the InvitedBy edge). */
  sender_name?: string;
  sender_user_id?: string;
}

@registerEntity
export class Invitation extends APIEntity<Invitation> implements IInvitation {
  recipient_email?: string;
  target_url_path?: string;
  accepted?: boolean;
  expiration_at?: string | Date;
  sent?: boolean;
  message?: string;
  target_type?: string;
  target_id?: string;
  target_name?: string;
  target_role?: string;
  sender_name?: string;
  sender_user_id?: string;
  static type: string = 'invitation';

  constructor(entity: Partial<IInvitation> = {}) {
    super(entity);
    this.recipient_email = entity.recipient_email;
    this.target_url_path = entity.target_url_path;
    this.accepted = entity.accepted;
    this.expiration_at = entity.expiration_at;
    this.sent = entity.sent;
    this.message = entity.message;
    this.target_type = entity.target_type;
    this.target_id = entity.target_id;
    this.target_name = entity.target_name;
    this.target_role = entity.target_role;
    this.sender_name = entity.sender_name;
    this.sender_user_id = entity.sender_user_id;
  }
}

export interface DeclineInvitationParams {
  invitation_id: string;
}

export interface DeclineInvitationResult {
  id: string;
}

/** Decline a pending invitation. Hub deletes the Invitation entity and
 *  notifies the inviter; the local SDK also removes the conversation that
 *  came embedded in the invitation. The UI surfaces this as "Delete" on
 *  an invitation row (rule 3 in the conversation-deletion plan). */
export async function declineInvitation(
  params: DeclineInvitationParams,
): Promise<DeclineInvitationResult> {
  const action = new ActionInfo('invitation-decline', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<DeclineInvitationParams, DeclineInvitationResult>(action);
  return res!;
}

/** True when an accept/decline failed because the invitation no longer exists
 *  on the hub (its node was deleted/reset). The backend self-heals — it removes
 *  the orphaned local mirror and answers HTTP 410 with ``data.gone``. Callers
 *  should treat this as "the row is already gone": show a soft "Invitation no
 *  longer valid" notice and refetch, rather than a hard error. */
export function isInvitationGoneError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { data?: { gone?: boolean } } } };
  return e?.response?.status === 410 || e?.response?.data?.data?.gone === true;
}
