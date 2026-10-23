/**
 * Which help-desk ticket buttons a viewer gets. Affordance only: the hub's policy decides.
 *
 * A ticket is reachable without being in it only as desk staff (the hub's `part_of_access`),
 * so "not in it" IS the staff case: they may pick it up (or just reply, which picks it up too)
 * and may close or reopen it. Anyone in it — the requester or staff who picked it up — may settle.
 */
export function ticketAffordances(viewer: {
  helpdesk: boolean;
  cloudUserId: string | null | undefined;
  isOwner: boolean;
  isParticipant: boolean;
}): { canPickup: boolean; canSettle: boolean } {
  const canPickup = viewer.helpdesk && !!viewer.cloudUserId && !viewer.isOwner && !viewer.isParticipant;
  const canSettle = viewer.helpdesk && (viewer.isOwner || viewer.isParticipant || canPickup);
  return { canPickup, canSettle };
}
