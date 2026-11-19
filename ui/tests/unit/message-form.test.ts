import { describe, expect, it, vi } from 'vitest';
import type { FlowMessage } from '@sdk';

const sendReply = vi.fn(async () => ({ id: 'r1' }));
vi.mock('@sdk/entities/notifications', () => ({ sendReply }));

const { indexForms, initialValues, leftToFill, submitFormAnswers } = await import(
  '@src/components/conversation/message-form'
);
type MessageForm = import('@src/components/conversation/message-form').MessageForm;

const FORM: MessageForm = {
  form_id: 'f1',
  title: 'Switch',
  fields: [
    { id: 'tenant', label: 'Tenant', type: 'one', options: ['a', 'b'], default: 'a' },
    { id: 'on', label: 'Switch on', type: 'date' },
    { id: 'note', label: 'Note', type: 'long_text', optional: true },
  ],
};

const carrier = (kind: string, id: string, value: object) => ({
  attachment_type: 'type_id',
  data: `${kind}-${id}`,
  prompt_preview: JSON.stringify(value),
});

const fm = (id: string, at: string, attachment: object[]) =>
  ({ id, created_date: at, attachment }) as unknown as FlowMessage;

describe('message forms', () => {
  it('pairs a form with its answers, newest last, each knowing the one it replaced', () => {
    const idx = indexForms([
      fm('a2', '2026-11-05T10:02:00Z', [carrier('form_answers', 'f1', { form_id: 'f1', values: { tenant: 'b' } })]),
      fm('m1', '2026-11-05T10:00:00Z', [carrier('message_form', 'f1', FORM)]),
      fm('a1', '2026-11-05T10:01:00Z', [carrier('form_answers', 'f1', { form_id: 'f1', values: { tenant: 'a' } })]),
    ]);
    expect(idx.formByMessage.get('m1')?.title).toBe('Switch');
    expect(idx.answersByForm.get('f1')?.map((e) => e.messageId)).toEqual(['a1', 'a2']);
    expect(idx.answersByMessage.get('a2')?.previous?.values).toEqual({ tenant: 'a' });
    // what changed is derived on read, never stored
    expect(idx.answersByMessage.get('a1')?.changed).toEqual([]);
    expect(idx.answersByMessage.get('a2')?.changed).toEqual(['tenant']);
    const dropped = indexForms([
      fm('a1', '2026-11-05T10:01:00Z', [carrier('form_answers', 'f1', { form_id: 'f1', values: { tenant: 'a', note: 'x' } })]),
      fm('a2', '2026-11-05T10:02:00Z', [carrier('form_answers', 'f1', { form_id: 'f1', values: { tenant: 'a' } })]),
    ]);
    expect(dropped.answersByMessage.get('a2')?.changed).toEqual(['note']); // a cleared answer is a change
  });

  it('answers with an ordinary reply carrying the answers as a typed value', async () => {
    await submitFormAnswers('c1', 'm1', 'f1', { tenant: 'b' }, []);
    expect(sendReply).toHaveBeenCalledWith({ conversationId: 'c1' }, '', [], {
      replyToId: 'm1',
      attachment: [
        {
          attachment_type: 'type_id',
          data: 'form_answers-f1',
          prompt_preview: JSON.stringify({ form_id: 'f1', values: { tenant: 'b' } }),
        },
      ],
    });
  });

  it('opens with defaults, and only the required empty fields are left to fill', () => {
    const values = initialValues(FORM, null);
    expect(values).toEqual({ tenant: 'a' });
    expect(leftToFill(FORM, values)).toEqual(['Switch on']);
    expect(leftToFill(FORM, { ...values, on: '2026-11-06' })).toEqual([]);
  });
});
