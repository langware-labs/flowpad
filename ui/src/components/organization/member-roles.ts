/**
 * Who a roster row is: a person or a group, the principal id the hub's members endpoints expect,
 * and which roles the caller may give it.
 *
 * Plain functions, out of `member-list.tsx` so that file exports only components — a non-component
 * export there breaks React Fast Refresh.
 */
import type { EntityMember } from '@sdk';

import { assignableRoles, participantRank } from '@src/components/conversation/participant-display';

/** A team/org that holds a role appears in the roster as a first-class row with
 *  ``user_id === null`` — the principal id lives in ``id``. */
export function isGroupMember(member: EntityMember): boolean {
  const type = (member as { type?: string }).type;
  return type === 'team' || type === 'organization';
}

/** The id the hub's members endpoints expect for this row (people and groups
 *  share the ``user_id`` slot on the wire; for a group it carries the principal). */
export function memberPrincipalId(member: EntityMember): string | undefined {
  return member.user_id ?? ((member as { id?: string }).id || undefined);
}

/**
 * Roles the caller may assign to this row.
 *
 * Delegates to the shared ``assignableRoles`` for people. Group rows need their
 * own path because that helper bails on a missing ``user_id``  — correctly, since
 * for a conversation such a row is a pending email invite that cannot be re-roled
 * by id. A group row is the opposite: it has no ``user_id`` by nature and is
 * always re-rolable, and it can never be "self", so only the ladder applies.
 */
export function assignableRolesForMember(me: EntityMember | null | undefined, member: EntityMember): string[] {
  if (!isGroupMember(member)) return assignableRoles(me as never, member as never);
  const myRank = participantRank(me as never);
  const targetRank = participantRank(member as never);
  if (myRank === null || targetRank === null) return [];
  if (targetRank <= myRank) return [];
  return assignableRoles(me as never, { ...(member as object), user_id: 'group' } as never);
}
