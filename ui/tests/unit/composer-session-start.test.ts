import { describe, expect, it } from 'vitest';
import { buildSessionStartExtras } from '@src/components/conversation/session-start';

const file = new File(['x'], 'shot.png', { type: 'image/png' });

describe('buildSessionStartExtras', () => {
  it('a turn of a live session: prompt text + the session id', () => {
    expect(buildSessionStartExtras({ text: 'again', files: [file], sessionId: 'sid' })).toEqual({
      promptText: 'again',
      promptFiles: [file],
      remoteWorkerSessionId: 'sid',
    });
  });

  it("with no session id the backend joins the conversation's open session", () => {
    expect(buildSessionStartExtras({ text: 'run it', files: [], sessionId: null })).toEqual({ promptText: 'run it' });
  });

  it('a command or a script names its kind — only inside a session, and a prompt names none', () => {
    const turn = (turnKind: string, sessionId: string | null) =>
      buildSessionStartExtras({ text: 'flow llm list', files: [], sessionId, turnKind }).turnKind;
    expect(turn('command', 'sid')).toBe('command');
    expect(turn('control', 'sid')).toBe('control');
    expect(turn('prompt', 'sid')).toBeUndefined();
    expect(turn('command', null)).toBeUndefined();
  });

  it('files ride as prompt files, never as plain message files', () => {
    const extras = buildSessionStartExtras({ text: 't', files: [file], sessionId: null });
    expect(extras.promptFiles).toEqual([file]);
    expect('files' in extras).toBe(false);
  });
});
