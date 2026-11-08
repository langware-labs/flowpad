/**
 * "New conversation" creates the conversation, then sends its first message. When that send is refused
 * (an attachment that cannot ship), no empty conversation may stay behind: it is deleted and the error
 * reaches the person. A retry that resumes an earlier attempt's conversation leaves it alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation, dataManager } from '@sdk';
import { createAndSendConversation } from '@sdk/entities/conversation-send';

afterEach(() => vi.restoreAllMocks());

const C1 = '11111111-1111-4111-8111-111111111111';
const C0 = '00000000-0000-4000-8000-000000000000';

function backend(refuse: boolean) {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- the mock stands in for an async action
  vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
    calls.push(info.name);
    if (info.name === 'conversation-create') return { conversation_id: C1 };
    if (info.name === 'delete') return {};
    if (refuse) throw new Error('Cannot send: skill-x — there is no local record of it');
    return { id: 'm1' };
  });
  return calls;
}

const params = { members: [], project_id: 'p1', title: 't' } as never;

describe('createAndSendConversation', () => {
  it('deletes the conversation it just created when the first message is refused', async () => {
    const calls = backend(true);

    await expect(createAndSendConversation(params, { text: 'hello' })).rejects.toThrow(/no local record/);

    expect(calls).toContain('delete');
  });

  it('keeps a conversation a retry resumed', async () => {
    const calls = backend(true);
    const draftRef = { current: new Conversation({ id: C0, type: 'conversation' } as never) };

    await expect(createAndSendConversation(params, { text: 'hello' }, { draftRef })).rejects.toThrow();

    expect(calls).not.toContain('delete');
  });

  it('a first message that goes through deletes nothing', async () => {
    const calls = backend(false);

    await createAndSendConversation(params, { text: 'hello' });

    expect(calls).not.toContain('delete');
  });
});
