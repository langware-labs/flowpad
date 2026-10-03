import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk';
import {
  findUnshippableReferences,
  hasSomethingToSend,
  withoutReferences,
  type ConversationSendPayload,
} from '@sdk/entities/conversation-send';

const SESSION = 'claude_session-aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PROCESS = 'agentic_process-bbbbbbbb-bbbb-4bbb-8bbb-000000000002';

afterEach(() => vi.restoreAllMocks());

// FLOWPAD-2153. Sharing a session whose transcript is gone must not leave the recipient with an empty
// bundle, and it must not create + invite first and fail after. These pin the pieces the share dialog
// leans on to ask first and to "send without it".
describe('findUnshippableReferences', () => {
  it('asks the backend once, with the references de-duplicated', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      unshippable: [{ type_id: SESSION, reason: 'its file is not on this machine' }],
    });

    const gaps = await findUnshippableReferences([SESSION, SESSION]);

    expect(gaps).toEqual([{ type_id: SESSION, reason: 'its file is not on this machine' }]);
    expect(call).toHaveBeenCalledTimes(1);
    const info = call.mock.calls[0][0] as { bodyParameters: { asset_references: string[] } };
    expect(info.bodyParameters.asset_references).toEqual([SESSION]);
  });

  it('does not call the backend when there is nothing attached', async () => {
    const call = vi.spyOn(dataManager, 'callAction');
    expect(await findUnshippableReferences([])).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it('treats a reply with no list as "nothing is wrong"', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({});
    expect(await findUnshippableReferences([SESSION])).toEqual([]);
  });
});

describe('withoutReferences', () => {
  const payload: ConversationSendPayload = {
    text: 'look at this',
    assetReferences: [SESSION, 'markdown-cccccccc-cccc-4ccc-8ccc-000000000003'],
    sharedContextEntities: [SESSION, PROCESS],
  };

  it('drops the reference from the attachments AND from the shared context, and nothing else', () => {
    const out = withoutReferences(payload, new Set([SESSION]));
    expect(out.assetReferences).toEqual(['markdown-cccccccc-cccc-4ccc-8ccc-000000000003']);
    expect(out.sharedContextEntities).toEqual([PROCESS]);
    expect(out.text).toBe('look at this');
  });

  it('leaves absent lists absent and never mutates its input', () => {
    const bare: ConversationSendPayload = { text: 'hi' };
    expect(withoutReferences(bare, new Set([SESSION]))).toEqual({ text: 'hi' });
    withoutReferences(payload, new Set([SESSION]));
    expect(payload.assetReferences).toHaveLength(2);
  });
});

describe('hasSomethingToSend', () => {
  it('needs text, a file or an attachment — shared context alone is not a message', () => {
    expect(hasSomethingToSend({ text: '  ', sharedContextEntities: [PROCESS] })).toBe(false);
    expect(hasSomethingToSend({ text: '', assetReferences: [] })).toBe(false);
    expect(hasSomethingToSend({ text: 'a note' })).toBe(true);
    expect(hasSomethingToSend({ text: '', assetReferences: [SESSION] })).toBe(true);
    expect(hasSomethingToSend({ text: '', files: [new File(['x'], 'x.txt')] })).toBe(true);
  });
});
