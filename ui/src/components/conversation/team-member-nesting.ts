/**
 * Nesting a roster's team members under their team row.
 *
 * The hub's roster lists everyone who reaches the entity, and a person who
 * reaches it only through a team comes back as an ordinary user row next to
 * that team's row. Shown flat, they look like direct members with their own
 * remove control, which removes nothing: their access is the team's.
 *
 * So each team row's own roster is read (the hub owns it), and a user row is
 * shown under the team when the user is on that team and holds no role beyond
 * the team's. Someone with a role of their own on top (``member, owner`` under a
 * ``member`` team) stays a top-level row, where that role can be managed.
 */
import { useEffect, useMemo, useState } from 'react';
import { getMembers, TypeId, type ConversationParticipant } from '@sdk';

import { isGroupMember, memberPrincipalId } from '@src/components/organization/member-roles';

/** A roster row's roles; the hub comma-joins a principal's roles (``member, owner``). */
export function roleSet(role: string | null | undefined): Set<string> {
  return new Set(
    (role ?? '')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface NestedRoster {
  /** The rows shown at the top level, in roster order (team rows included). */
  top: ConversationParticipant[];
  /** Team principal id → the user rows shown under that team. */
  childrenOf: Map<string, ConversationParticipant[]>;
}

/**
 * Split ``members`` into top-level rows and rows nested under a team.
 *
 * ``rosters`` maps a team's principal id to the user ids on that team. A user
 * row nests under the first team row whose roster holds it and whose roles
 * cover all of the user's roles; any other row stays top level.
 */
export function nestTeamMembers(members: ConversationParticipant[], rosters: Map<string, Set<string>>): NestedRoster {
  const teams = members.filter(isGroupMember);
  const top: ConversationParticipant[] = [];
  const childrenOf = new Map<string, ConversationParticipant[]>();
  for (const member of members) {
    const parent = isGroupMember(member) ? undefined : teams.find((team) => coveredBy(member, team, rosters));
    const parentId = parent ? memberPrincipalId(parent) : undefined;
    if (!parentId) {
      top.push(member);
      continue;
    }
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), member]);
  }
  return { top, childrenOf };
}

function coveredBy(
  member: ConversationParticipant,
  team: ConversationParticipant,
  rosters: Map<string, Set<string>>,
): boolean {
  const teamId = memberPrincipalId(team);
  if (!member.user_id || !teamId || !rosters.get(teamId)?.has(member.user_id)) return false;
  const teamRoles = roleSet(team.role);
  const roles = roleSet(member.role);
  return roles.size > 0 && [...roles].every((r) => teamRoles.has(r));
}

/**
 * The user ids on each team row of ``members``, read from the hub.
 *
 * One ``members`` read per team, re-run when the set of team rows changes. A
 * team whose roster can't be read is left out, so its people stay top level.
 */
export function useTeamRosters(members: ConversationParticipant[]): Map<string, Set<string>> {
  const teamIds = useMemo(
    () =>
      members
        .filter((m) => (m as { type?: string }).type === 'team')
        .map((m) => memberPrincipalId(m))
        .filter((id): id is string => !!id)
        .sort()
        .join(','),
    [members],
  );
  const [rosters, setRosters] = useState<Map<string, Set<string>>>(() => new Map());

  useEffect(() => {
    let live = true;
    const ids = teamIds ? teamIds.split(',') : [];
    void Promise.all(
      ids.map(async (id) => {
        try {
          const rows = await getMembers(new TypeId('team', id));
          const users = rows.filter((r) => !isGroupMember(r)).map((r) => r.user_id);
          return [id, new Set(users.filter((u): u is string => !!u))] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!live) return;
      setRosters(new Map(entries.filter((e): e is readonly [string, Set<string>] => e !== null)));
    });
    return () => {
      live = false;
    };
  }, [teamIds]);

  return rosters;
}
