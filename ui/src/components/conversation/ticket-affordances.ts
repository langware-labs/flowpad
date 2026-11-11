/**
 * Which help-desk ticket buttons a viewer gets. Affordance only: the hub's policy decides.
 *
 * A ticket is reachable without being in it only as desk staff (the hub's `part_of_access`),
 * so "not in it" IS the staff case: they may pick it up (or just reply, which picks it up too)
 * and may close or reopen it. Anyone in it — the requester or staff who picked it up — may settle.
 */
/** A staffer's own reply picks the ticket up on the hub; the roster that says so is now stale. */
export function replyPickedUp(
  canPickup: boolean,
  lastSenderId: string | null | undefined,
  cloudUserId: string | null | undefined,
) {
  return canPickup && !!cloudUserId && lastSenderId === cloudUserId;
}

export function ticketAffordances(viewer: {
  helpdesk: boolean;
  cloudUserId: string | null | undefined;
  isOwner: boolean;
  isParticipant: boolean;
}): { canPickup: boolean; canSettle: boolean } {
  const canPickup = viewer.helpdesk && !!viewer.cloudUserId && !viewer.isOwner && !viewer.isParticipant;
  // Closing is the desk's: the person who asked sees a conversation, not a ticket to manage.
  const canSettle = viewer.helpdesk && !viewer.isOwner && (viewer.isParticipant || !!viewer.cloudUserId);
  return { canPickup, canSettle };
}

/** Geometry shared by the ticket actions (the status button and the action beside it). Only the
 *  colour differs between them, so a padding or type-scale tweak belongs in one place. */
export const ticketActionClassName =
  'flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors disabled:opacity-50';

export type TicketVerb = 'close' | 'reopen' | 'pickup' | 'return';

/** The hub calls that move a ticket to `target`, in order. A closed ticket is reopened on its way to
 *  either open state; one already there needs nothing. `mine`: the viewer is staff in the ticket. */
export function ticketStatusSteps(
  target: 'waiting' | 'picked' | 'closed',
  now: { closed: boolean; mine: boolean },
): TicketVerb[] {
  if (target === 'closed') return now.closed ? [] : ['close'];
  const steps: TicketVerb[] = now.closed ? ['reopen'] : [];
  if (target === 'picked' && !now.mine) steps.push('pickup');
  if (target === 'waiting' && now.mine) steps.push('return');
  return steps;
}
