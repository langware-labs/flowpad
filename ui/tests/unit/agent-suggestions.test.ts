/**
 * Which agents the New conversation form and the contacts book offer.
 *
 * Locked here:
 *  - A hub deployment is offered when the hub allows the caller `use` on it (the
 *    action name in the hub's policies.json) and its machine signs in as an agent.
 *  - This computer's own placement, a deployment the caller may not add, and one whose machine signs
 *    in as a person or as nobody are never offered.
 *  - A picked agent is one participant keyed `deployment-<id>`, granted reader + runner.
 */
import { describe, expect, it } from 'vitest';
import { deploymentTypeIdOf, isDeploymentParticipant } from '@sdk/entities/conversation';
import {
  agentParticipant,
  filterAgents,
  invitableAgents,
  type HubDeploymentRow,
} from '@src/components/contact-picker/use-agent-suggestions';
import { participantKey } from '@src/components/contact-picker/use-contacts';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;

function deployment(n: number, over: Partial<HubDeploymentRow> = {}, allowed: string[] | null = ['use']) {
  return {
    id: UUID(n),
    name: `helper-${n} (e2b)`,
    identity: 'deployment',
    target: { provider: 'e2b' },
    expand: { roles: ['admin'], allowed_actions: allowed },
    ...over,
  };
}

describe('invitableAgents', () => {
  it('offers a hub deployment the caller may add to a conversation', () => {
    expect(invitableAgents([deployment(1)])).toEqual([{ id: UUID(1), name: 'helper-1 (e2b)' }]);
  });

  it('offers one whose machine signs in as its agent', () => {
    expect(invitableAgents([deployment(1, { identity: 'agent' })])).toHaveLength(1);
  });

  it('offers one the caller owns: the hub names the action type-qualified, the desk answers `*`', () => {
    expect(invitableAgents([deployment(1, {}, ['deployment.use']), deployment(2, {}, ['*'])])).toHaveLength(2);
  });

  it('never offers one the hub does not let the caller add', () => {
    expect(invitableAgents([deployment(1, {}, ['read'])])).toEqual([]);
  });

  it('never offers one read without its permissions', () => {
    expect(invitableAgents([deployment(1, {}, null)])).toEqual([]);
  });

  it('never offers this computer’s own placement', () => {
    expect(invitableAgents([deployment(1, { target: { provider: 'local' } })])).toEqual([]);
  });

  it('never offers one whose machine signs in as a person or as nobody', () => {
    expect(invitableAgents([deployment(1, { identity: 'user' }), deployment(2, { identity: 'none' })])).toEqual([]);
  });

  it('matches the name as the person types', () => {
    expect(filterAgents(invitableAgents([deployment(1), deployment(2)]), 'HELPER-2')).toEqual([
      { id: UUID(2), name: 'helper-2 (e2b)' },
    ]);
  });
});

describe('agentParticipant', () => {
  it('is one participant keyed deployment-<id>, granted reader + runner', () => {
    const p = agentParticipant({ id: UUID(1), name: 'helper-1 (e2b)' });
    expect(p).toMatchObject({ kind: 'deployment', typeid: `deployment-${UUID(1)}`, name: 'helper-1 (e2b)' });
    expect(p.roles).toEqual(['reader', 'runner']);
    expect(p.user_id ?? null).toBeNull();
    expect(p.email ?? null).toBeNull();
    expect(participantKey(p)).toBe(`deployment-${UUID(1)}`);
    expect(isDeploymentParticipant(p)).toBe(true);
    expect(deploymentTypeIdOf(p)?.toString()).toBe(`deployment-${UUID(1)}`);
  });

  it('does not collide with a person who has the agent’s name', () => {
    const person = { name: 'helper-1 (e2b)', email: null };
    expect(isDeploymentParticipant(person)).toBe(false);
    expect(participantKey(person)).not.toBe(participantKey(agentParticipant({ id: UUID(1), name: 'helper-1 (e2b)' })));
  });
});
