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

// `implements IInvitation` only checks the class; it contributes no members, so every
// field declared solely on IInvitation read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Invitation extends Omit<IInvitation, 'expand' | 'id' | 'is_private' | 'members'> {}

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

export type DeclineInvitationParams = {
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

/** The hub's `pending` wire shape. `target` and `inviter` are nested there,
 *  while the local `Invitation` entity carries them flattened — see
 *  `fetchPendingInvitations` for why the two differ. */
interface PendingInvitationWire extends IInvitation {
  target?: { type?: string; id?: string; name?: string; role?: string } | null;
  inviter?: { user_id?: string; name?: string } | null;
}

/**
 * Live invitations addressed to the signed-in user — `GET invitation/pending`.
 *
 * Necessary because the ordinary entity query cannot see these. Invitations are
 * saved with NO owner, so a recipient holds no role on the row and the standard
 * role-scoped read returns nothing for exactly the people the row is for. The
 * hub's `pending` action sidesteps that deliberately (`for_recipient` passes
 * `source_entity=None`) and self-scopes on the email instead.
 *
 * On the desktop this is invisible: the local SDK polls `pending` and mirrors
 * the rows into local entities, so a generic query finds them. Against the hub
 * directly there is no mirror, which is why the hub inbox needs this call.
 *
 * The nested `target`/`inviter` are flattened to the `target_*`/`sender_*`
 * fields the `Invitation` entity and the inbox row already read, so callers
 * see one shape regardless of where the rows came from.
 */
export async function fetchPendingInvitations(): Promise<Invitation[]> {
  const action = new ActionInfo('pending', Invitation.type, null, 'GET');
  action.hubReflect = true; // invitations are hub-owned
  const rows = await dataManager.callAction<undefined, PendingInvitationWire[]>(action);
  if (!Array.isArray(rows)) return [];
  return rows.map(
    (row) =>
      new Invitation({
        ...row,
        target_type: row.target?.type,
        target_id: row.target?.id,
        target_name: row.target?.name,
        target_role: row.target?.role,
        sender_name: row.inviter?.name,
        sender_user_id: row.inviter?.user_id,
      }),
  );
}

/**
 * Accept an invitation against the HUB — `GET members/accept?invitation-id=`.
 *
 * Not the same endpoint as `acceptInvitation`, which posts to the desktop-only
 * `invitation-accept` action (it also unpacks the conversation bundle, which is
 * a local-SDK concern). Against the hub that action does not exist and answers
 * 422, so the hub inbox needs this instead.
 *
 * The hub answers with a 302 to the post-accept landing; the grant has already
 * happened by then, so the redirect is irrelevant here and only the absence of
 * an error matters.
 */
export async function acceptInvitationOnHub(invitationId: string): Promise<void> {
  const action = new ActionInfo('members', null, null, 'GET');
  action.subpath = 'accept';
  action.queryParameters = { 'invitation-id': invitationId };
  action.hubReflect = true;
  await dataManager.callAction<undefined, unknown>(action);
}

/** Decline against the HUB — `POST invitation/decline`, the class-level action.
 *  The desktop's `invitation-decline` does not exist there. */
export async function declineInvitationOnHub(invitationId: string): Promise<void> {
  const action = new ActionInfo('decline', Invitation.type, null, 'POST');
  action.bodyParameters = { invitation_id: invitationId };
  action.hubReflect = true;
  await dataManager.callAction<{ invitation_id: string }, unknown>(action);
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
