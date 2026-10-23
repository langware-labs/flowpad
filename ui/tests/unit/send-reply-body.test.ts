/**
 * sendReply speaks the hub's own `add_message` shape, so one call works against either server:
 * a FlowMessage body (`type`, `text`) for a plain reply, and a multipart form whose text field is
 * `text` (never the old `message`) when files ride along.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, sendReply } from '@sdk';

const CONVERSATION_ID = '9d0c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';

describe('sendReply body', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a plain reply is a FlowMessage body with text', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ id: 'm1' } as never);

    await sendReply({ conversationId: CONVERSATION_ID }, 'hello', undefined, { replyToId: 'r1' });

    const info = call.mock.calls[0][0] as any;
    expect(info.name ?? info.action).toBe('add_message');
    expect(info.bodyParameters).toEqual({ type: 'flow_message', text: 'hello', reply_to_id: 'r1' });
  });

  it('a reply with files is multipart and carries the text as `text`', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ id: 'm2' } as never);

    await sendReply({ conversationId: CONVERSATION_ID }, 'with a file', [new File(['x'], 'a.txt')]);

    const form = (call.mock.calls[0][0] as any).bodyParameters as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('text')).toBe('with a file');
    expect(form.get('message')).toBeNull();
    expect((form.get('files') as File).name).toBe('a.txt');
  });
});
