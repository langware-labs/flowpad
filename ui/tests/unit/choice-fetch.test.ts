/**
 * The picker's state machine, without rendering anything.
 *
 * The promise it carries: nothing-to-pick is never an error state. The backend answers
 * HTTP 200 for "no connection", "missing scope" and "no project id" alike, because all
 * three mean the same thing to the person filling the form — type it instead. A thrown
 * request lands in the same place, so the field can only ever do one thing with a list it
 * did not get. Rendering any of them as a failure puts a red banner where a working text
 * input belongs, and the difference is invisible in a screenshot of the happy path.
 */
import { describe, expect, it } from 'vitest';
import {
  failedFetch,
  fallsBackToTyping,
  mergeChoices,
  nextFetch,
} from '@src/components/data-sources/choice-fetch';

describe('nextFetch', () => {
  it('is ready when the provider listed something', () => {
    const answer = { items: [{ id: 'C1', name: 'general' }], detail: '' };
    expect(nextFetch(answer)).toEqual({ status: 'ready', choices: answer.items });
  });

  it('is unpickable, never an error, when the list is empty and a sentence says why', () => {
    const answer = { items: [], detail: "Set 'GCP project' to list buckets." };
    expect(nextFetch(answer)).toEqual({ status: 'unpickable', detail: answer.detail });
  });

  it('still falls back to typing when nothing came back and nothing explained it', () => {
    // An account with genuinely no shared drives reads the same as a refusal: there is
    // nothing to pick, so the field has to let the value be typed.
    expect(nextFetch({ items: [], detail: '' }).status).toBe('unpickable');
    expect(nextFetch(null).status).toBe('unpickable');
  });

  it('carries the reason through so the field can show it', () => {
    const state = nextFetch({ items: [], detail: 'Connect Google first.' });
    expect(state.status === 'unpickable' && state.detail).toBe('Connect Google first.');
  });
});

describe('failedFetch', () => {
  it('lands a thrown request in the SAME state as a polite no, with its message', () => {
    // Not a separate `error` status: nothing downstream ever told the two apart, and a
    // second name for "no list" is how one of them eventually gets drawn as a failure.
    expect(failedFetch(new Error('offline'))).toEqual({ status: 'unpickable', detail: 'offline' });
  });
});

describe('fallsBackToTyping', () => {
  it('is true exactly for the state with no list to show', () => {
    expect(fallsBackToTyping({ status: 'unpickable', detail: 'x' })).toBe(true);
    expect(fallsBackToTyping({ status: 'unfetched' })).toBe(false);
    expect(fallsBackToTyping({ status: 'loading' })).toBe(false);
    expect(fallsBackToTyping({ status: 'ready', choices: [] })).toBe(false);
  });
});

describe('mergeChoices', () => {
  it('keeps a picked entry the provider no longer offers', () => {
    // An archived channel still IS what the source reads. Dropping it here would make it
    // vanish from the form and then from the saved config on the next edit.
    const merged = mergeChoices(
      [{ id: 'C_OLD', name: 'archived' }],
      [{ id: 'C1', name: 'general' }],
    );
    expect(merged.map((c) => c.id)).toEqual(['C1', 'C_OLD']);
  });

  it('does not duplicate one that is both picked and offered', () => {
    const merged = mergeChoices([{ id: 'C1', name: 'general' }], [{ id: 'C1', name: 'general' }]);
    expect(merged).toHaveLength(1);
  });
});
