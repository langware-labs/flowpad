import { ActionInfo, Conversation, dataManager, deleteConversation, leaveConversation, QueryRequest } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONVERSATION_ID = '319dae3d-69d5-446a-8e02-c5e9a6560934';

function sent(spy: ReturnType<typeof vi.spyOn>): { name: string; method: string; body: unknown }[] {
  return spy.mock.calls.map(([action]) => {
    const info = action as ActionInfo;
    return { name: info.name, method: info.method ?? 'GET', body: info.bodyParameters };
  });
}

describe('one call shape, whichever server answers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a text reply is a FlowMessage body over REST', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ id: 'm1' } as never);
    const ws = vi.spyOn(dataManager, 'callActionPreferWS');

    expect(await sendReply({ conversationId: CONVERSATION_ID }, 'hello', undefined, { replyToId: 'm0' })).toEqual({
      id: 'm1',
    });

    expect(ws).not.toHaveBeenCalled();
    expect(sent(call)).toEqual([
      { name: 'add_message', method: 'POST', body: { type: 'flow_message', text: 'hello', reply_to_id: 'm0' } },
    ]);
  });

  it('an invite is the hub MembershipRequest, by email or by user id', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([] as never);
    const conversation = new Conversation({ id: CONVERSATION_ID, type: Conversation.type } as never);

    await conversation.inviteMember('Bob@Example.test');
    await conversation.inviteMember('user-1beb3507-0000-4000-8000-000000000001');

    const target = [{ typeid: `conversation-${CONVERSATION_ID}`, role: 'member' }];
    expect(sent(call)).toEqual([
      { name: 'members', method: 'POST', body: { recipient_email: 'bob@example.test', invitation_targets: target } },
      {
        name: 'members',
        method: 'POST',
        body: { recipient_user_id: '1beb3507-0000-4000-8000-000000000001', invitation_targets: target },
      },
    ]);
  });

  it('leave and delete are the conversation actions the hub has', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);

    await leaveConversation({ conversation_id: CONVERSATION_ID });
    await deleteConversation({ conversation_id: CONVERSATION_ID, mode: 'delete_for_all', agent_id: 'a1' });

    expect(sent(call)).toEqual([
      { name: 'leave', method: 'POST', body: {} },
      { name: 'delete', method: 'DELETE', body: { agent_id: 'a1' } },
    ]);
  });

  it('a delete the person chose as "remove here" says so, so it never widens to everyone', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);

    await deleteConversation({ conversation_id: CONVERSATION_ID, mode: 'local' });

    expect(sent(call)).toEqual([{ name: 'delete', method: 'DELETE', body: { mode: 'local' } }]);
  });

  it('a type the server does not list is answered empty without a request', async () => {
    await dataManager.loadTypes([{ type_name: 'conversation' } as never]);
    const get = vi.spyOn(dataManager, 'callAction');

    expect(dataManager.servesType('conversation')).toBe(true);
    expect(dataManager.servesType('micro_app')).toBe(false);
    expect(await dataManager.query(new QueryRequest({ type: 'micro_app', name: 'apps-unserved' }))).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('a new conversation invites with the hub call', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves, then one members MembershipRequest per invitee', async () => {
    const { createConversationForShare } = await import('@sdk/entities/conversation-send');
    const save = vi.spyOn(Conversation.prototype, 'save').mockImplementation(async function (this: Conversation) {
      return this;
    } as never);
    const invite = vi.spyOn(Conversation.prototype, 'inviteMember').mockResolvedValue(undefined);
    const share = vi.spyOn(Conversation.prototype, 'share');

    await createConversationForShare({
      participants: [{ email: 'Bob@Example.test' }, { user_id: 'u-2' }],
      title: 'hello',
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(share).not.toHaveBeenCalled();
    expect(invite.mock.calls.map(([who]) => who)).toEqual(['bob@example.test', 'u-2']);
  });
});

describe('a hub conversation row reads like a row kept here', () => {
  it('lifts participants to members and initiated_by to created_by', () => {
    const conv = new Conversation({
      id: CONVERSATION_ID,
      participants: [{ user_id: 'u1', name: 'Bob' }],
      initiated_by: 'owner-1',
    } as never);
    expect(conv.members).toEqual([{ user_id: 'u1', name: 'Bob' }]);
    expect(conv.created_by).toBe('owner-1');
  });

  it('keeps a desktop row as it is', () => {
    const conv = new Conversation({
      id: CONVERSATION_ID,
      members: [{ user_id: 'me' }],
      created_by: 'local-owner',
    } as never);
    expect(conv.members).toEqual([{ user_id: 'me' }]);
    expect(conv.created_by).toBe('local-owner');
  });
});
