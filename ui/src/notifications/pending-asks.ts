/**
 * The open questions `askNotification` is waiting on, by notification id.
 *
 * Its own module because both the answer (`notification.answer`, `ask.ts`) and every close
 * (`closeShown` and the toast's `onDismiss`, `notify.ts`) settle one, and `ask.ts` imports
 * `notify` — living in either would make an import cycle.
 */

export interface AskAnswer {
  /** The chosen `choices[].value`; null when the question was closed without an answer. */
  value: string | null;
  /** The "Don't ask again" box was ticked when the answer was given. */
  remember: boolean;
}

const pending = new Map<string, (answer: AskAnswer) => void>();

export function holdAsk(id: string, resolve: (answer: AskAnswer) => void): void {
  // A second question under the same id replaces the first; the first is closed, not lost.
  settleAsk(id);
  pending.set(id, resolve);
}

/** Answer the question `id` is waiting on; no answer means it was closed. A no-op when none is open. */
export function settleAsk(id: string, answer: AskAnswer = { value: null, remember: false }): void {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(answer);
}
