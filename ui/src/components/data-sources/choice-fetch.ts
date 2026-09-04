import type { DataSourceChoice, DataSourceChoiceSet } from '@sdk';

/**
 * What the picker knows about a field's options right now.
 *
 * Pulled out of the component as a plain function so the one branch that actually matters
 * has a test that renders nothing: an empty list WITH a sentence is a refusal, not an
 * error. The backend answers HTTP 200 for "no connection", "missing scope" and "no project
 * id" alike, because for the person filling the form all three mean the same thing — type
 * it instead — and treating any of them as an error would put a red failure where a
 * working text input belongs.
 */
export type ChoiceFetch =
  | { status: 'unfetched' }
  | { status: 'loading' }
  | { status: 'ready'; choices: DataSourceChoice[] }
  /** Nothing to pick, and one sentence saying why. ONE state, not a `refused`/`error`
   *  pair: no reader ever needed to tell a provider's polite no from a failed request —
   *  both hand the field back to typing and print `detail` — and keeping them apart
   *  invited a future reader to render the "error" one as a failure, which is exactly
   *  the mistake this module exists to prevent. */
  | { status: 'unpickable'; detail: string };

/** The provider's answer → what the field should draw. */
export function nextFetch(answer: DataSourceChoiceSet | null | undefined): ChoiceFetch {
  const choices = answer?.items ?? [];
  if (choices.length) return { status: 'ready', choices };
  // Nothing to pick. A sentence says why; without one there is genuinely nothing there —
  // an account with no shared drives — and that reads the same way: type it instead.
  return {
    status: 'unpickable',
    detail: answer?.detail || 'Nothing to pick here — type the value instead.',
  };
}

/** A thrown request → the same shape, so the field has one branch, not two. */
export function failedFetch(error: unknown): ChoiceFetch {
  return { status: 'unpickable', detail: error instanceof Error ? error.message : String(error) };
}

/** True when the field should draw its ordinary text input instead of a picker.
 *
 *  A type PREDICATE, not a bare boolean: it selects the one state that carries a
 *  `detail`, and the caller renders that sentence right after asking. With a plain
 *  `boolean` the union never narrows and reading `fetch.detail` does not compile. */
export const fallsBackToTyping = (
  fetch: ChoiceFetch,
): fetch is Extract<ChoiceFetch, { status: 'unpickable' }> => fetch.status === 'unpickable';

/**
 * What the picker lists: everything offered, plus anything already picked that the
 * provider no longer returns.
 *
 * A channel that was archived after the source was configured still IS what the source
 * reads. Dropping it from the list would make it vanish from the form and then from the
 * saved config on the next edit — a silent unsubscribe nobody asked for.
 */
export function mergeChoices(
  picked: DataSourceChoice[],
  offered: DataSourceChoice[],
): DataSourceChoice[] {
  const seen = new Set(offered.map((c) => c.id));
  return [...offered, ...picked.filter((c) => !seen.has(c.id))];
}
