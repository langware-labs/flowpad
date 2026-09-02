import { ActionInfo, archiveConversation, dataManager, fetchConversations } from '@sdk';
import { sendToChannel } from '@sdk/entities/notifications';
import { bulkUpdateMessages, searchInbox, updateMessage } from '@src/components/inbox-view/inbox-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

afterEach(() => vi.restoreAllMocks());

describe('Agent-scoped Inbox actions', () => {
  it('carries agent_id through reads and mutations', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);

    await fetchConversations(AGENT_ID);
    await searchInbox('treasure', AGENT_ID);
    await updateMessage(MESSAGE_ID, { is_read: true }, AGENT_ID);
    await bulkUpdateMessages({ is_read: true }, AGENT_ID);
    await archiveConversation({ conversation_id: CONVERSATION_ID, agent_id: AGENT_ID });
    await sendToChannel(CONVERSATION_ID, 'Arr', AGENT_ID);

    const actions = call.mock.calls.map((entry) => entry[0] as ActionInfo);
    expect(actions.map((action) => action.name)).toEqual([
      'conversation-list',
      'inbox-search',
      'inbox-update',
      'inbox-bulk-update',
      'conversation-archive',
      'send_external',
    ]);
    for (const action of actions) expect(action.bodyParameters).toMatchObject({ agent_id: AGENT_ID });
  });
});
