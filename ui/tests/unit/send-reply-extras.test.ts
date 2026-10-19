import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { unitTestSetup } from '../utils/test-utils';

const CONV = '44444444-4444-4444-8444-444444444444';

describe('sendReply session extras', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  it('text-only send puts reply_policy + remote_worker_session_id in the JSON body', async () => {
    const spy = vi.spyOn(dataManager, 'callActionPreferWS').mockResolvedValue(undefined as never);
    await sendReply({ conversationId: CONV }, '', undefined, { promptText: 'go', replyPolicy: 'review' });
    const action = spy.mock.calls[0][0];
    expect(action.name).toBe('add_message');
    expect(action.bodyParameters).toEqual({ message: '', prompt_text: 'go', reply_policy: 'review' });

    await sendReply({ conversationId: CONV }, '', undefined, { promptText: 'more', remoteWorkerSessionId: 'sid' });
    const follow = spy.mock.calls[1][0];
    expect(follow.bodyParameters).toEqual({ message: '', prompt_text: 'more', remote_worker_session_id: 'sid' });
  });

  it('multipart send carries the same fields as form entries', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    await sendReply({ conversationId: CONV }, '', undefined, { promptText: 'go', promptFiles: [file], replyPolicy: 'auto' });
    const form = (spy.mock.calls[0][0]).bodyParameters as FormData;
    expect(form.get('prompt_text')).toBe('go');
    expect(form.get('reply_policy')).toBe('auto');
    expect((form.get('prompt_files') as File).name).toBe('shot.png');
    expect(form.get('remote_worker_session_id')).toBeNull();
  });
});
