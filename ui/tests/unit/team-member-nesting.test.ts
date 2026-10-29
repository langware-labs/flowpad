/**
 * Which roster rows sit under a team row (`nestTeamMembers`).
 *
 * A person nests under a team they are on when the team's role covers all of
 * theirs; a role of their own on top keeps them a top-level row.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationParticipant } from '@sdk';

import { nestTeamMembers, roleSet } from '@src/components/conversation/team-member-nesting';

const team = (id: string, roles = ['reader']) =>
  ({ type: 'team', id, user_id: null, name: id, roles }) as unknown as ConversationParticipant;
const user = (id: string, roles: string[]) => ({ user_id: id, name: id, roles }) as ConversationParticipant;

describe('nestTeamMembers', () => {
  it('nests a team member whose roles the team covers, keeping roster order at the top level', () => {
    const members = [user('owner', ['owner']), team('t1'), user('dana', ['reader'])];
    const { top, childrenOf } = nestTeamMembers(members, new Map([['t1', new Set(['dana'])]]));

    expect(top.map((m) => m.name)).toEqual(['owner', 't1']);
    expect(childrenOf.get('t1')?.map((m) => m.name)).toEqual(['dana']);
  });

  it('keeps a team member with a role beyond the team at the top level', () => {
    const members = [team('t1'), user('sam', ['reader', 'owner'])];
    const { top, childrenOf } = nestTeamMembers(members, new Map([['t1', new Set(['sam'])]]));

    expect(top.map((m) => m.name)).toEqual(['t1', 'sam']);
    expect(childrenOf.size).toBe(0);
  });

  it('keeps a person who is not on the team, or whose team roster is unknown, at the top level', () => {
    const members = [team('t1'), team('t2'), user('eve', ['reader']), user('ann', ['reader'])];
    const { top } = nestTeamMembers(members, new Map([['t1', new Set(['ann'])]]));

    expect(top.map((m) => m.name)).toEqual(['t1', 't2', 'eve']);
  });

  it('nests a person on two teams under the first team row', () => {
    const members = [team('t1'), team('t2'), user('dana', ['reader'])];
    const rosters = new Map([
      ['t1', new Set(['dana'])],
      ['t2', new Set(['dana'])],
    ]);

    expect(
      nestTeamMembers(members, rosters)
        .childrenOf.get('t1')
        ?.map((m) => m.name),
    ).toEqual(['dana']);
  });
});

describe('roleSet', () => {
  it('splits the comma-joined roles the hub sends', () => {
    expect([...roleSet(['reader', 'runner'])]).toEqual(['reader', 'runner']);
    expect(roleSet(null).size).toBe(0);
  });
});
