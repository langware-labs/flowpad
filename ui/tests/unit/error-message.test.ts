/**
 * `errorMessage` — the precedence ladder that four copy-pasted catch blocks
 * used to each own. Backend detail wins over anything we could invent locally:
 * when the server explains itself, that is the message worth showing.
 */
import { describe, it, expect } from 'vitest';

import { errorMessage } from '@src/lib/error-message';

describe('errorMessage', () => {
  it('prefers a real Error message', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
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
