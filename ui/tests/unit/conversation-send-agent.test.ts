/**
 * "New conversation" with an agent picked: the agent is added through the same
 * `members` call a person is invited with, as a `principal` -- never as an email or a user id -- with
 * reader + runner on the conversation. An agent alone is enough to make the conversation a hub one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk';
import { agentParticipant } from '@sdk/entities/conversation';
import { createConversationForShare, hasRemoteParticipant } from '@sdk/entities/conversation-send';

afterEach(() => vi.restoreAllMocks());

const A1 = '550e8400-e29b-41d4-a716-446655440001';
const AGENT = agentParticipant(A1, 'helper (e2b)');

interface MembersCall {
  principal?: string;
  recipient_email?: string;
  invitation_targets: { typeid: string; roles: string[] }[];
}

function backend() {
  const calls: { name: string; body: MembersCall }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- the mock stands in for an async save
  vi.spyOn(dataManager, 'save').mockImplementation(async (_typeId, _scope, json) => json as never);
  // eslint-disable-next-line @typescript-eslint/require-await -- the mock stands in for an async action
  vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
    calls.push({ name: info.name, body: info.bodyParameters as MembersCall });
    return [];
  });
  return calls;
}

describe('createConversationForShare with an agent', () => {
  it('an agent alone makes it a hub conversation', () => {
    expect(hasRemoteParticipant([AGENT])).toBe(true);
  });

  it('adds the agent as a principal with reader + runner', async () => {
    const calls = backend();

    const { conversation_id } = await createConversationForShare({ members: [AGENT], title: 't' } as never);

    expect(calls.map((c) => c.name)).toEqual(['members']);
    expect(calls[0].body).toEqual({
      principal: `agent-${A1}`,
      invitation_targets: [{ typeid: `conversation-${conversation_id}`, roles: ['reader', 'runner'] }],
    });
  });

  it('invites the people too, and never addresses the agent as a person', async () => {
    const calls = backend();

    await createConversationForShare({ members: [AGENT, { email: 'dana@example.com' }], title: 't' } as never);

    expect(calls.map((c) => c.body.recipient_email ?? c.body.principal)).toEqual([
      'dana@example.com',
      `agent-${A1}`,
    ]);
  });
});
