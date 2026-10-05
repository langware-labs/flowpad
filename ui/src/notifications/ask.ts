import { notify } from './notify';
import { registerCommand } from './commands';
import { holdAsk, settleAsk, type AskAnswer } from './pending-asks';
import type { NotificationLocation } from './types';

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
export interface AskInput {
  id: string;
  title: string;
  message?: string;
  /** In order; the first renders as the primary button. */
  choices: { value: string; label: string }[];
  /** Present → the toast shows this checkbox (unticked). */
  remember?: { label: string };
  /** `center` when the question must be answered before anything goes on (default `corner`). */
  location?: NotificationLocation;
}

export function askNotification(input: AskInput): Promise<AskAnswer> {
  return new Promise((resolve) => {
    holdAsk(input.id, resolve);
    notify.info({
      id: input.id,
      title: input.title,
      message: input.message,
      remember: input.remember,
      location: input.location,
      durationMs: null,
      actions: input.choices.map((c) => ({
        label: c.label,
        command: 'notification.answer',
        args: { value: c.value },
      })),
    });
  });
}

registerCommand('notification.answer', (args, ctx) => {
  settleAsk(ctx.id, { value: String(args.value), remember: args.remember === true });
  notify.dismiss(ctx.id);
});

export type { AskAnswer };
