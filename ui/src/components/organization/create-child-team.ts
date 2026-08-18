import { APIEntity, TypeId } from '@sdk';

/**
 * Create a team under a parent organization or team.
 *
 * Two calls, because the hub expresses two different relationships and the UI
 * needs both:
 *   1. the SCOPED CREATE writes containment (parent -> team), which is what gives
 *      the parent's members their role on the new team — including the person who
 *      just created it, who otherwise holds nothing on it;
 *   2. the MEMBERS grant writes membership (team -> parent), which is what puts
 *      the team in the parent's roster and flows its people upward.
 * Containment alone produces a team nobody can find; membership alone produces one
 * its creator cannot administer.
 *
 * Extracted so both the page and the graph drawer create teams identically.
 */
export async function createChildTeam(parentTypeId: TypeId, name: string): Promise<TypeId> {
  const { dataManager, Team } = await import('@sdk');
  const draft = new Team({ name });
  await dataManager.save(draft.typeId, [parentTypeId], draft.toJSON() as never);

  const parent = await dataManager.getByTypeId<APIEntity<never>>(parentTypeId);
  if (!parent) throw new Error('Parent entity not loaded');
  await parent.addGroupMember(draft.typeId, 'member');
  return draft.typeId;
}
