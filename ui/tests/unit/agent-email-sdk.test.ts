import { ActionInfo, Agent, DataSource, EmailInbox, dataManager } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';
const INBOX_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';

const wireState = {
  agent_id: AGENT_ID,
  enabled: true,
  inbox: {
    typeid: `agent_mailbox-${INBOX_ID}`,
    address: 'pirate@example.com',
    provider: 'agentmail',
    provider_inbox_id: 'provider-1',
    status: 'active',
    agent_typeid: `agent-${AGENT_ID}`,
    allowed_senders: ['captain@example.com'],
    filters: { labels: 'received' },
  },
  source: {
    id: SOURCE_ID,
    typeid: `data_source-${SOURCE_ID}`,
    status: 'active',
    health: 'ok',
    poll_interval_seconds: 60,
  },
};

afterEach(() => vi.restoreAllMocks());

describe('Agent inbox actions', () => {
  it('hydrates the mailbox and its DataSource from inbox_state', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(wireState as never);
    const state = await new Agent({ id: AGENT_ID }).inboxState();

    expect((call.mock.calls[0][0] as ActionInfo).name).toBe('inbox_state');
    expect(state.inbox).toBeInstanceOf(EmailInbox);
    expect(state.inbox?.id).toBe(INBOX_ID);
    expect(state.source).toBeInstanceOf(DataSource);
    expect(state.source?.id).toBe(SOURCE_ID);
  });

  it('carries the allowlist on the mailbox, and gates on it there', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(wireState as never);
    const state = await new Agent({ id: AGENT_ID }).inboxState();

    // The allowlist is the mailbox's policy, not the agent's — and the gate
    // mirrors Python: closed by default, case-insensitive, kill switch wins.
    expect(state.inbox?.allowed_senders).toEqual(['captain@example.com']);
    expect(state.inbox?.filters).toEqual({ labels: 'received' });
    expect(state.inbox?.allowed('  Captain@Example.com ')).toBe(true);
    expect(state.inbox?.allowed('stranger@example.com')).toBe(false);

    const paused = new EmailInbox({ ...wireState.inbox, status: 'disabled' } as never);
    expect(paused.allowed('captain@example.com')).toBe(false);
  });

  it('routes the mailbox lifecycle to its own actions', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ ...wireState, inbox: null, source: null } as never);
    const agent = new Agent({ id: OTHER_AGENT_ID });

    await agent.allocateInbox();
    await agent.allocateInbox({ allowed_senders: ['captain@example.com'] });
    await agent.configureInbox({
      allowed_senders: ['captain@example.com'],
      filters: { labels: 'received' },
      poll_interval_seconds: 60,
    });
    await agent.disableInbox();

    const [allocate, allocateWith, configure, disable] = call.mock.calls.map((entry) => entry[0] as ActionInfo);
    // Allocation takes the allowlist in the same call that makes the mailbox —
    // and stays parameterless when you have nothing to declare.
    expect(allocate.name).toBe('allocate_inbox');
    expect(allocate.bodyParameters).toEqual({});
    expect(allocateWith.bodyParameters).toEqual({ allowed_senders: ['captain@example.com'] });
    expect(configure.name).toBe('configure_inbox');
    expect(configure.bodyParameters).toEqual({
      allowed_senders: ['captain@example.com'],
      filters: { labels: 'received' },
      poll_interval_seconds: 60,
    });
    expect(disable.name).toBe('disable_inbox');
  });
});
