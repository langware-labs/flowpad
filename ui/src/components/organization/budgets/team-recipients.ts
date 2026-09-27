/**
 * The "N people will be invited" PREVIEW for sharing a project with a team — the
 * team's own people plus the people inside any team nested in it.
 *
 * Only a count. The share itself posts the TEAM to the `share` action and the
 * backend (`Project.share` → `_expand_share_teams` in `flow_sdk/builtin/project.py`)
 * does the real walk at send time and reports what it could not expand, so this
 * walk mirrors its rules without competing with it: approved person rows count,
 * keyed by hub `user_id` (else email); pending rows are invitations, not
 * members; group rows are walked, with `visited` stopping a membership cycle. A
 * nested team whose member list refuses the caller contributes nobody here — the
 * send reports it as a skipped team. Runs once per dialog opening, not on render.
 */
import { TypeId, getMembers } from '@sdk';

import { isGroupMember, memberPrincipalId } from '@src/components/organization/member-list';

export interface TeamRecipients {
  /** One key per distinct person the share will invite (hub `user_id`, else `email:<address>`). */
  people: string[];
  /** Approved person rows with neither a user id nor an email — nothing to send to. */
  unreachable: number;
}

/** Walk `teamTypeId` and everything nested in it, counting its approved people. */
export async function collectTeamRecipients(teamTypeId: TypeId): Promise<TeamRecipients> {
  const people = new Set<string>();
  let unreachable = 0;
  const visited = new Set<string>();

  const walk = async (typeId: TypeId, nested: boolean): Promise<void> => {
    const key = typeId.toString();
    if (visited.has(key)) return;
    visited.add(key);

    // The picked team's own refusal is the dialog's error; a nested one only
    // contributes nobody (the send names it in `skipped_teams`).
    const members = nested ? await getMembers(typeId).catch(() => []) : await getMembers(typeId);
    const groups: TypeId[] = [];
    for (const m of members) {
      if (isGroupMember(m)) {
        const id = memberPrincipalId(m);
        const type = (m as { type?: string }).type;
        if (id && type) groups.push(new TypeId(type, id));
        continue;
      }
      if ((m.status ?? 'approved').toLowerCase() !== 'approved') continue;
      const userId = m.user_id?.trim();
      const email = (m.email ?? '').trim().toLowerCase();
      if (userId) people.add(userId);
      else if (email) people.add(`email:${email}`);
      else unreachable += 1;
    }
    // Sequential on purpose: a deep org would otherwise fan out one hub request
    // per team at once, and this runs behind a button press, not a render.
    for (const group of groups) await walk(group, true);
  };

  await walk(teamTypeId, false);
  return { people: Array.from(people), unreachable };
}
