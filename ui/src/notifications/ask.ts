import { notify } from './notify';
import { registerCommand } from './commands';
import { holdAsk, settleAsk, type AskAnswer } from './pending-asks';
import type { NotificationInput } from './types';

/**
 * A notification that asks: a sticky toast with one button per choice and, optionally, a
 * "Don't ask again" box. Resolves with the choice, or `value: null` when the toast is closed.
 *
 *   const { value, remember } = await askNotification({ id, title, choices, remember: { label } });
 *
 * The toast stays serializable — each button is the `notification.answer` command carrying its
 * value — so remembering is the CALLER's business: it writes the answer into the preference the
 * question belongs to, which is what makes "don't ask again" a setting the person can see and undo.
 */
export type AskInput = Pick<NotificationInput, 'title' | 'message' | 'remember' | 'location'> & {
  id: string;
  /** In order; the first renders as the primary button. */
  choices: { value: string; label: string }[];
};

export function askNotification(input: AskInput): Promise<AskAnswer> {
  return new Promise((resolve) => {
    holdAsk(input.id, resolve);
    const { choices, ...shown } = input;
    notify.info({
      ...shown,
      durationMs: null,
      actions: choices.map((c) => ({ label: c.label, command: 'notification.answer', args: { value: c.value } })),
    });
  });
}

registerCommand('notification.answer', (args, ctx) => {
  settleAsk(ctx.id, { value: String(args.value), remember: args.remember === true });
  notify.dismiss(ctx.id);
});

export type { AskAnswer };
