import { useEffect, useMemo, useState } from 'react';
import {
  getMembers,
  normalizeEmail,
  QueryRequest,
  Team,
  TypeId,
  type AnyEntity,
  type ConversationParticipant,
  type EntityMember,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { isGroupMember } from '@src/components/organization/member-roles';

/** A team the sharer can share with as a whole (R2). */
export interface TeamSuggestion {
  id: string;
  name: string;
}

/** A team row the desk knows about — materialized when the user joined it. */
interface KnownTeam {
  id?: string | null;
  name?: string | null;
  remote?: boolean | null;
}

/**
 * The teams to offer: the hub teams (`remote`) this desk knows the user is in.
 * A desk-only team has no hub roster to expand, so it is not offered — the
 * query already asks for `remote` rows only; this keeps the rule for any rows
 * handed in directly. Whether
 * the user may list a team's members is not checked here; a team whose member
 * list the hub refuses contributes nobody at send time and is reported as skipped.
 */
export function knownTeams(teams: KnownTeam[]): TeamSuggestion[] {
  return teams
    .filter((t): t is KnownTeam & { id: string } => !!t.id && t.remote === true)
    .map((t) => ({ id: t.id, name: (t.name ?? '').trim() || t.id }));
}

/** Filter teams by a name query (case-insensitive). Empty → all. */
export function filterTeams<T extends TeamSuggestion>(teams: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return teams;
  return teams.filter((t) => t.name.toLowerCase().includes(q));
}

/**
 * The role a picked team is shown with. A team carries no role of its own on the
 * wire (`teams` is ids only); the backend grants the team as one principal at
 * `PROJECT_DEFAULT_INVITE_ROLE` (`flow_sdk/builtin/project.py`), which this mirrors.
 */
export const TEAM_INVITE_ROLE = 'member';

/**
 * A picked team as a participant: ONE entry keyed `team-<id>`, never its
 * members. Its `role` is `TEAM_INVITE_ROLE`, fixed. `Project.invite` posts it to the
 * `share` action, which grants the team on the hub as ONE principal — never expanded.
 */
export function teamParticipant(team: TeamSuggestion): ConversationParticipant {
  return {
    kind: Team.type,
    typeid: new TypeId(Team.type, team.id).toString(),
    name: team.name,
    user_id: null,
    email: null,
    role: TEAM_INVITE_ROLE,
  };
}

/**
 * A team's roster as the PEOPLE to message — for surfaces that address people,
 * not principals (a new conversation). Nested group rows (a sub-team, an org)
 * and rows with no address are dropped; only who the roster names directly is sent.
 */
export function teamMemberParticipants(roster: EntityMember[]): ConversationParticipant[] {
  return roster
    .filter((m) => !isGroupMember(m) && (m.user_id || m.email))
    .map((m) => ({ user_id: m.user_id ?? null, email: normalizeEmail(m.email), name: m.name ?? null }));
}

export function isTeamParticipant(p: ConversationParticipant): boolean {
  return p.kind === Team.type && typeof p.typeid === 'string' && p.typeid.length > 0;
}

/** The team a team participant stands for, or null for a person. */
export function teamTypeIdOf(p: ConversationParticipant): TypeId | null {
  if (!isTeamParticipant(p)) return null;
  try {
    const typeId = new TypeId(p.typeid as string);
    return typeId.type === Team.type ? typeId : null;
  } catch {
    return null;
  }
}

/**
 * The teams the sharer can pick (`knownTeams`). Nothing is read while `enabled`
 * is false, so surfaces that do not offer teams never ask.
 */
export function useTeamSuggestions(enabled: boolean): { teams: TeamSuggestion[] } {
  // Hub teams only — filtered by the local query, not after the fact.
  const request = useMemo(() => new QueryRequest({ type: Team.type, query: { remote: true } }), []);
  const { data: rows } = useEntitiesQuery<AnyEntity>(request, { enabled });
  const teams = useMemo(() => (enabled ? knownTeams((rows ?? []) as KnownTeam[]) : []), [enabled, rows]);
  return { teams };
}

/** A team the user may message: its roster, already read, as the people to add. */
export interface MessageableTeam extends TeamSuggestion {
  members: ConversationParticipant[];
}

/**
 * The teams the user may message as a whole — those whose roster the hub let
 * them read. A roster the hub refuses comes back EMPTY (the local server falls
 * back to its cache), never as an error, and a readable roster always names at
 * least the reader — so "someone besides me" is the permission signal. Such a
 * team is not offered at all. One ``members`` read per team, while ``enabled``.
 */
export function useMessageableTeams(enabled: boolean, excludeUserId?: string | null): { teams: MessageableTeam[] } {
  const { teams } = useTeamSuggestions(enabled);
  const [rosters, setRosters] = useState<Map<string, ConversationParticipant[]>>(() => new Map());
  const teamIds = useMemo(() => teams.map((t) => t.id).join(','), [teams]);

  useEffect(() => {
    if (!enabled || !teamIds) return;
    let live = true;
    void Promise.all(
      teamIds.split(',').map(async (id): Promise<[string, ConversationParticipant[]]> => {
        try {
          return [id, teamMemberParticipants(await getMembers(new TypeId(Team.type, id)))];
        } catch {
          return [id, []];
        }
      }),
    ).then((entries) => {
      if (live) setRosters(new Map(entries));
    });
    return () => {
      live = false;
    };
  }, [enabled, teamIds]);

  return useMemo(
    () => ({
      teams: teams
        .map((t) => ({ ...t, members: (rosters.get(t.id) ?? []).filter((m) => m.user_id !== excludeUserId) }))
        .filter((t) => t.members.length > 0),
    }),
    [teams, rosters, excludeUserId],
  );
}
