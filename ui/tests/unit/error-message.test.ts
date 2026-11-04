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

describe('a FastAPI 422 is a sentence, not an object', () => {
  // The crash: `detail` is typed `string` but a route bound straight to FastAPI answers a
  // rejected body with a LIST of pydantic issues. The array passed through `||`, reached
  // `setNotice`, and React was asked to render an object — which killed the whole page,
  // because there is no ErrorBoundary between a view and the route's errorElement.
  const validationError = {
    response: {
      data: {
        detail: [
          { type: 'extra_forbidden', loc: ['body', 'run_id'], msg: 'Extra inputs are not permitted', input: 'x1' },
        ],
      },
    },
  };

  it('reads the issue as body.field: message', () => {
    expect(errorMessage(validationError, 'fallback')).toBe('body.run_id: Extra inputs are not permitted');
  });

  it('always returns a string, which is what a caller renders', () => {
    expect(typeof errorMessage(validationError, 'fallback')).toBe('string');
  });

  it('joins several issues', () => {
    const two = { response: { data: { detail: [
      { loc: ['body', 'a'], msg: 'required' },
      { loc: ['body', 'b'], msg: 'too long' },
    ] } } };
    expect(errorMessage(two, 'fallback')).toBe('body.a: required; body.b: too long');
  });

  it('falls back when the detail carries nothing sayable', () => {
    expect(errorMessage({ response: { data: { detail: [{}] } } }, 'fallback')).toBe('fallback');
    expect(errorMessage({ response: { data: { detail: {} } } }, 'fallback')).toBe('fallback');
  });
});
