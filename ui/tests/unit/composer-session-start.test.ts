import { describe, expect, it } from 'vitest';
import { buildSessionStartExtras } from '@src/components/conversation/session-start';

const file = new File(['x'], 'shot.png', { type: 'image/png' });

describe('buildSessionStartExtras', () => {
  it('a NEW session: prompt text + reply policy, no session id (the backend mints it)', () => {
    expect(buildSessionStartExtras({ text: 'run it', files: [], sessionId: null, replyPolicy: 'review' })).toEqual({
      promptText: 'run it',
      replyPolicy: 'review',
    });
  });

  it('a follow-up: prompt text + session id, and the reply policy is NOT sent', () => {
    expect(buildSessionStartExtras({ text: 'again', files: [file], sessionId: 'sid', replyPolicy: 'review' })).toEqual({
      promptText: 'again',
      promptFiles: [file],
      remoteWorkerSessionId: 'sid',
    });
  });

  it('files ride as prompt files, never as plain message files', () => {
    const extras = buildSessionStartExtras({ text: 't', files: [file], sessionId: null, replyPolicy: 'auto' });
    expect(extras.promptFiles).toEqual([file]);
    expect('files' in extras).toBe(false);
  });
});
