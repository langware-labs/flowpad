/**
 * Everyone a team's project should reach — the team's own people plus the people
 * inside any team nested in it.
 *
 * Nested teams are walked rather than skipped because that is what team
 * membership MEANS here: a team holding a role on another team confers it on
 * everyone inside, so "share with the team" that stopped at the first level
 * would quietly miss most of a school. The hub is the only thing that knows a
 * team's roster, so each level is a `members` read; they run once, when the
 * admin confirms, not on render.
 *
 * Invitations travel by email address (`MembershipRequest.recipient_email`), so
 * a roster row without one cannot be invited at all. Those are counted, not
 * dropped silently — the dialog says how many people it could not reach.
 */
import { TypeId, getMembers, type Participant } from '@sdk';

import { isGroupMember, memberPrincipalId } from '@src/components/organization/member-list';

export interface TeamRecipients {
  /** De-duped, lower-cased addresses to invite. */
  emails: string[];
  /** Roster rows that are people but carry no address — nothing to send to. */
  unreachable: number;
}

/** The group rows on one roster, as the typeIds their own roster is read from. */
function nestedTeams(members: Participant[]): TypeId[] {
  const out: TypeId[] = [];
  for (const m of members) {
    if (!isGroupMember(m)) continue;
    const id = memberPrincipalId(m);
    const type = (m as { type?: string }).type;
    if (id && type) out.push(new TypeId(type, id));
  }
  return out;
}

/**
 * Walk `teamTypeId` and everything nested in it, collecting addresses.
 *
 * `visited` guards the walk: a team that (directly or through a chain) holds a
 * role on itself would otherwise recurse forever, and the hub does not promise
 * the graph is acyclic.
 */
export async function collectTeamRecipients(teamTypeId: TypeId): Promise<TeamRecipients> {
  const emails = new Set<string>();
  let unreachable = 0;
  const visited = new Set<string>();

  const walk = async (typeId: TypeId): Promise<void> => {
    const key = typeId.toString();
    if (visited.has(key)) return;
    visited.add(key);

    const members = await getMembers(typeId);
    for (const m of members) {
      if (isGroupMember(m)) continue;
      const email = (m.email || '').trim().toLowerCase();
      if (email) emails.add(email);
      else unreachable += 1;
    }
    // Sequential on purpose: a deep org would otherwise fan out one hub request
    // per team at once, and this runs behind a button press, not a render.
    for (const nested of nestedTeams(members)) await walk(nested);
  };

  await walk(teamTypeId);
  return { emails: Array.from(emails), unreachable };
}
