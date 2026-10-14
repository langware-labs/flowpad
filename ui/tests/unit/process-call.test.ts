import { describe, expect, it } from 'vitest';
import { AttachmentType, type FlowMessage } from '@sdk';
import { callOutcome, indexCallAnswers, processCallOf } from '@src/components/conversation/process-call';

const fm = (id: string, attachment: FlowMessage['attachment']) => ({ id, attachment }) as FlowMessage;
const callFm = fm('m1', [
  {
    attachment_type: AttachmentType.TYPE_ID,
    data: 'process_call-c1',
    prompt_preview: JSON.stringify({ call_id: 'c1', exe: { prompt: 'switch to feature/x' } }),
  },
]);
const answerFm = (answer: object) =>
  fm('m2', [
    { attachment_type: AttachmentType.TYPE_ID, data: 'returned_value-c1', prompt_preview: JSON.stringify(answer) },
  ]);

describe('process call on a message', () => {
  it('reads the call and pairs its answer by call id, marking the answer message', () => {
    expect(processCallOf(callFm)?.exe?.prompt).toBe('switch to feature/x');
    const { byCall, answerMessageIds } = indexCallAnswers([
      callFm,
      answerFm({ exit_code: 0, detail: 'On feature/x.' }),
    ]);
    expect(byCall.get('c1')?.detail).toBe('On feature/x.');
    expect([...answerMessageIds]).toEqual(['m2']);
  });

  it('a malformed preview is no call', () => {
    expect(
      processCallOf(
        fm('m', [{ attachment_type: AttachmentType.TYPE_ID, data: 'process_call-c1', prompt_preview: '{' }]),
      ),
    ).toBeNull();
  });

  it('tells good, bad, error and declined apart by fields, never by the sentence', () => {
    expect(callOutcome({ exit_code: 0 })).toBe('good');
    expect(callOutcome({ exit_code: 1, reported: true, detail: 'error everywhere' })).toBe('bad');
    expect(callOutcome({ exit_code: 1, reported: false, detail: 'all good' })).toBe('error');
    expect(callOutcome({ exit_code: 7, ran: false })).toBe('declined');
  });
});
