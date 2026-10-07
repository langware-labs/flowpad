import type { FlowMessage } from '@sdk';
import { describe, expect, it } from 'vitest';
import { failedPromptOf, pendingPromptOf, sessionEventOf } from '@src/components/conversation/session-turns';

const SID = 'a1a1a1a1-0000-4000-8000-000000000001';
const carrier = (marker: Record<string, unknown>) => ({
  attachment_type: 'type_id',
  data: `remote_worker_session-${SID}`,
  prompt_preview: JSON.stringify(marker),
});

// Plain rows: the helpers only read `attachment`/`text`, and an entity instance would reach for a backend.
const fm = (row: Record<string, unknown>) => row as unknown as FlowMessage;
const prompt = (id: string, text: string) =>
  fm({ id, attachment: [{ attachment_type: 'type_id', data: `prompt-${id}`, prompt_preview: text }, carrier({})] });
const failedLine = (id: string) =>
  fm({ id, text: 'The host could not run this prompt', attachment: [carrier({ live_session_event: 'failed' })] });
const approvedLine = (id: string) => fm({ id, attachment: [carrier({ live_session_event: 'approved' })] });
const reply = (id: string) =>
  fm({ id, attachment: [{ attachment_type: 'type_id', data: `prompt_completion-${id}`, prompt_preview: 'ok' }] });

describe('sessionEventOf', () => {
  it('reads the lifecycle event off the carrier marker, null otherwise', () => {
    expect(sessionEventOf(failedLine('e1'))).toBe('failed');
    expect(sessionEventOf(prompt('p1', 'hi'))).toBeNull();
    expect(sessionEventOf(reply('r1'))).toBeNull();
  });
});

describe('failedPromptOf', () => {
  it('names the last prompt when a failed line follows it and no reply does', () => {
    const got = failedPromptOf([approvedLine('a'), prompt('p1', 'what is your git user name'), failedLine('e1')]);
    expect(got?.message.id).toBe('p1');
    expect(got?.text).toBe('what is your git user name');
  });

  it('is null once the prompt was answered, or retried by a newer prompt', () => {
    expect(failedPromptOf([prompt('p1', 'a'), failedLine('e1'), reply('r1')])).toBeNull();
    expect(failedPromptOf([prompt('p1', 'a'), failedLine('e1'), prompt('p2', 'a')])).toBeNull();
  });

  it('only the LAST prompt counts: an old failure followed by success is gone', () => {
    expect(failedPromptOf([prompt('p1', 'a'), failedLine('e1'), prompt('p2', 'b'), reply('r2')])).toBeNull();
  });

  it('a failure with no prompt before it offers nothing to retry', () => {
    expect(failedPromptOf([failedLine('e1')])).toBeNull();
  });
});

describe('pendingPromptOf', () => {
  it('names the last prompt while nothing answered it — the next prompt replaces it', () => {
    expect(pendingPromptOf([approvedLine('a'), prompt('p1', 'list the files')])).toBe('list the files');
    expect(pendingPromptOf([prompt('p1', 'a'), reply('r1'), prompt('p2', 'run the tests')])).toBe('run the tests');
  });

  it('is null once a reply or a failed line follows it, and before any prompt', () => {
    expect(pendingPromptOf([prompt('p1', 'a'), reply('r1')])).toBeNull();
    expect(pendingPromptOf([prompt('p1', 'a'), failedLine('e1')])).toBeNull();
    expect(pendingPromptOf([approvedLine('a')])).toBeNull();
  });
});
