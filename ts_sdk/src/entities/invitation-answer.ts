import { hubModeReady, isHubOnly } from '../utils/hub-runtime';
import { acceptInvitation } from './conversation';
import { acceptInvitationOnHub, declineInvitation, declineInvitationOnHub } from './invitation';

/**
 * Answer an invitation where this page runs: the hub page asks the hub, the desktop its own backend
 * (which also brings the shared thing down to this machine). Every Accept / Decline button goes through
 * here, so none can pick the wrong side.
 */
export async function answerInvitation(invitationId: string, answer: 'accept' | 'decline'): Promise<void> {
  await hubModeReady();
  if (isHubOnly()) {
    await (answer === 'accept' ? acceptInvitationOnHub(invitationId) : declineInvitationOnHub(invitationId));
  } else if (answer === 'accept') {
    await acceptInvitation({ invitation_id: invitationId });
  } else {
    await declineInvitation({ invitation_id: invitationId });
  }
}
