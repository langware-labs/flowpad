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
}

@registerEntity
export class Invitation extends APIEntity<Invitation> implements IInvitation {
  recipient_email?: string;
  target_url_path?: string;
  accepted?: boolean;
  expiration_at?: string | Date;
  sent?: boolean;
  message?: string;
  static type: string = 'invitation';

  constructor(entity: Partial<IInvitation> = {}) {
    super(entity);
    this.recipient_email = entity.recipient_email;
    this.target_url_path = entity.target_url_path;
    this.accepted = entity.accepted;
    this.expiration_at = entity.expiration_at;
    this.sent = entity.sent;
    this.message = entity.message;
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
