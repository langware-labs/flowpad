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
  },
  source: {
    id: SOURCE_ID,
    typeid: `data_source-${SOURCE_ID}`,
    status: 'active',
    health: 'ok',
    poll_interval_seconds: 60,
  },
  allowed_senders: ['captain@example.com'],
};

afterEach(() => vi.restoreAllMocks());

describe('Agent email actions', () => {
  it('hydrates the formal Inbox and DataSource from email_state', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(wireState as never);
    const state = await new Agent({ id: AGENT_ID }).emailState();

    expect((call.mock.calls[0][0] as ActionInfo).name).toBe('email_state');
    expect(state.inbox).toBeInstanceOf(EmailInbox);
    expect(state.inbox?.id).toBe(INBOX_ID);
    expect(state.source).toBeInstanceOf(DataSource);
    expect(state.source?.id).toBe(SOURCE_ID);
  });

  it('keeps enable parameterless and configuration explicit', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ ...wireState, inbox: null, source: null } as never);
    const agent = new Agent({ id: OTHER_AGENT_ID });

    await agent.enableEmail();
    await agent.configureEmail({ allowed_senders: ['captain@example.com'], poll_interval_seconds: 60 });
    await agent.disableEmail();

    const [enable, configure, disable] = call.mock.calls.map((entry) => entry[0] as ActionInfo);
    expect(enable.name).toBe('enable_email');
    expect(enable.bodyParameters).toEqual({});
    expect(configure.name).toBe('configure_email');
    expect(configure.bodyParameters).toEqual({
      allowed_senders: ['captain@example.com'],
      poll_interval_seconds: 60,
    });
    expect(disable.name).toBe('disable_email');
  });
});
