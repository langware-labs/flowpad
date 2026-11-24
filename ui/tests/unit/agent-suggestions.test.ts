/**
 * Which agents the New conversation form and the contacts book offer.
 *
 * Locked here:
 *  - A hub agent is offered when the caller holds a role on it. Which of its deployments answers is the
 *    hub's decision when the agent is added, never the picker's.
 *  - A row read without its permissions is never offered.
 *  - A picked agent is one participant keyed `agent-<id>`, granted reader + runner.
 */
import { describe, expect, it } from 'vitest';
import { agentTypeIdOf, isAgentParticipant } from '@sdk/entities/conversation';
import {
  agentParticipant,
  filterAgents,
  invitableAgents,
  type HubAgentRow,
} from '@src/components/contact-picker/use-agent-suggestions';
import { participantKey } from '@src/components/contact-picker/use-contacts';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;

function agent(n: number, over: Partial<HubAgentRow> = {}): HubAgentRow {
  return {
    id: UUID(n),
    name: `helper-${n}`,
    expand: { roles: ['admin'], allowed_actions: ['*'] },
    ...over,
  };
}

describe('invitableAgents', () => {
  it('offers an agent the caller holds a role on', () => {
    expect(invitableAgents([agent(1)])).toEqual([{ id: UUID(1), name: 'helper-1' }]);
  });

  it('never offers one read without its permissions', () => {
    expect(invitableAgents([agent(1, { expand: null }), agent(2, { expand: { roles: [] } })])).toEqual([]);
  });

  it('names an agent without a name by its id', () => {
    expect(invitableAgents([agent(1, { name: ' ' })])).toEqual([{ id: UUID(1), name: UUID(1) }]);
  });

  it('matches the name as the person types', () => {
    expect(filterAgents(invitableAgents([agent(1), agent(2)]), 'HELPER-2')).toEqual([{ id: UUID(2), name: 'helper-2' }]);
  });
});

describe('agentParticipant', () => {
  it('is one participant keyed agent-<id>, granted reader + runner', () => {
    const p = agentParticipant({ id: UUID(1), name: 'helper-1' });
    expect(p).toMatchObject({ kind: 'agent', typeid: `agent-${UUID(1)}`, name: 'helper-1' });
    expect(p.roles).toEqual(['reader', 'runner']);
    expect(p.user_id ?? null).toBeNull();
    expect(p.email ?? null).toBeNull();
    expect(participantKey(p)).toBe(`agent-${UUID(1)}`);
    expect(isAgentParticipant(p)).toBe(true);
    expect(agentTypeIdOf(p)?.toString()).toBe(`agent-${UUID(1)}`);
  });

  it('does not collide with a person who has the agent’s name', () => {
    const person = { name: 'helper-1', email: null };
    expect(isAgentParticipant(person)).toBe(false);
    expect(participantKey(person)).not.toBe(participantKey(agentParticipant({ id: UUID(1), name: 'helper-1' })));
  });
});
