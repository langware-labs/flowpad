/**
 * `errorMessage` — the precedence ladder that four copy-pasted catch blocks
 * used to each own. Backend detail wins over anything we could invent locally:
 * when the server explains itself, that is the message worth showing.
 */
import { describe, it, expect } from 'vitest';

import { errorMessage, isUnfundedHarness } from '@src/lib/error-message';

describe('errorMessage', () => {
  it('prefers a real Error message', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('reads the envelope off an axios rejection, which is also an Error', () => {
    // The shape that matters in practice: axios throws an Error whose message
    // is the status line and whose `response.data` holds what the server said.
    const axiosish = Object.assign(new Error('Request failed with status code 500'), {
      response: { data: { status: 'FAIL', message: 'Desktop OAuth not supported for provider: slack' } },
    });

    expect(errorMessage(axiosish, 'fallback')).toBe('Desktop OAuth not supported for provider: slack');
  });

  it('prefers the backend detail over every other field', () => {
    const err = {
      response: { data: { detail: 'backend detail', message: 'backend message' } },
      detail: 'top detail',
      message: 'top message',
    };

    expect(errorMessage(err, 'fallback')).toBe('backend detail');
  });

  it('falls through response.data.message, then top-level detail, then message', () => {
    expect(errorMessage({ response: { data: { message: 'rd-message' } }, detail: 'd' }, 'f')).toBe('rd-message');
    expect(errorMessage({ detail: 'top detail', message: 'top message' }, 'f')).toBe('top detail');
    expect(errorMessage({ message: 'top message' }, 'f')).toBe('top message');
  });

  it('uses the fallback for shapes it cannot read', () => {
    expect(errorMessage({}, 'fallback')).toBe('fallback');
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
    expect(errorMessage('a bare string', 'fallback')).toBe('fallback');
  });

  it('does not return an empty Error message', () => {
    // An Error with no message would otherwise blank the toast.
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback');
  });
});

/**
 * The one signal that routes a funding failure to the LLM Sources page.
 *
 * MIRRORED in python — both producers open with this sentence, and each side
 * has a test pinning the literal so they cannot drift:
 *   - `LLMSourceError` (cli_drivers/llm_source.py), raised at spawn;
 *   - the create gate (builtin/faas/scan_actions.py), which refuses earlier.
 *
 * The envelope carries no error code, so the sentence is the only thing to
 * branch on. The create gate returned the bare REASON once — a true sentence
 * that this predicate could not recognise — and a launch refused for funding
 * landed the user on Capabilities, offering to install a harness they had.
 */
describe('isUnfundedHarness', () => {
  it('recognises the spawn-time error', () => {
    const spawn =
      'claude has no usable LLM source:\n' +
      '  - claude device login: claude is set to use flowpad\n' +
      '  - openrouter key: claude is set to use flowpad';
    expect(isUnfundedHarness({ response: { data: { message: spawn } } })).toBe(true);
  });

  it('recognises the create-time refusal, which opens the same way', () => {
    const create = 'claude_code has no usable LLM source: claude is set to use flowpad';
    expect(isUnfundedHarness({ response: { data: { message: create } } })).toBe(true);
  });

  it('does NOT match the bare reason on its own', () => {
    // The regression, stated: a true sentence carrying no signal. Matching it
    // would mean guessing from wording the resolver is free to change.
    expect(isUnfundedHarness({ response: { data: { message: 'claude is set to use flowpad' } } })).toBe(false);
  });

  it('does not fire on an unrelated failure', () => {
    expect(isUnfundedHarness(new Error('Claude CLI is not installed on this machine.'))).toBe(false);
    expect(isUnfundedHarness(new Error('Workspace is read-only.'))).toBe(false);
    expect(isUnfundedHarness(null)).toBe(false);
  });
});
