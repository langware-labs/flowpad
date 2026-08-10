import { describe, expect, it } from 'vitest';
import { capabilityErrorFrom, errorMessage } from '@src/lib/error-message';

/**
 * FLOWPAD-1971: creating a chat session against a provider whose harness CLI is
 * not installed answered HTTP 500 with a bare python string, and the UI showed
 * "Request failed with status code 500". The backend now refuses with a
 * structured 400; these tests pin the shape the UI reads it out of.
 *
 * The nesting is the part worth guarding: `apiClient` unwraps the
 * `{status, message, data}` envelope only on SUCCESS. The error path rethrows
 * the raw axios error, so the backend's `data` sits at `response.data.data`.
 */

/** An axios rejection as it really arrives — an Error that also carries `response`. */
function axiosFailure(status: number, body: unknown): Error {
  const err = new Error(`Request failed with status code ${status}`);
  Object.assign(err, { response: { status, data: body } });
  return err;
}

const CAPABILITY_400 = axiosFailure(400, {
  status: 'FAIL',
  message: 'Codex CLI is not installed on this machine.',
  data: {
    health: 'config_error',
    code: 'not_installed',
    detail: 'harness is not installed',
    worker_type: 'codex',
    capability_kind: 'harness.codex.cli',
    name: 'Codex CLI',
    homepage_url: 'https://example.invalid/codex',
  },
});

describe('capabilityErrorFrom', () => {
  it('lifts the capability identity out of the doubly-nested envelope', () => {
    expect(capabilityErrorFrom(CAPABILITY_400)).toEqual({
      code: 'not_installed',
      capabilityKind: 'harness.codex.cli',
      workerType: 'codex',
      name: 'Codex CLI',
    });
  });

  it('reads the human message from the envelope, not axios status text', () => {
    // The whole point of the ticket: `err.message` here is the useless
    // "Request failed with status code 400".
    expect(errorMessage(CAPABILITY_400, 'fallback')).toBe(
      'Codex CLI is not installed on this machine.',
    );
  });

  it('recognises the other config-error codes', () => {
    for (const code of ['not_authenticated', 'no_api_key']) {
      const failure = axiosFailure(400, { status: 'FAIL', data: { code } });
      expect(capabilityErrorFrom(failure)?.code).toBe(code);
    }
  });

  it('reports missing optional fields as null rather than guessing', () => {
    const bare = axiosFailure(400, { status: 'FAIL', data: { code: 'not_installed' } });
    expect(capabilityErrorFrom(bare)).toEqual({
      code: 'not_installed',
      capabilityKind: null,
      workerType: null,
      name: null,
    });
  });

  describe('returns null so unrelated failures keep their existing handling', () => {
    it.each([
      ['a transient launch code', axiosFailure(500, { status: 'FAIL', data: { code: 'crash_signal' } })],
      ['a legacy bare 500 from an older backend', axiosFailure(500, { status: 'FAIL', message: 'boom' })],
      ['a payload with no code', axiosFailure(400, { status: 'FAIL', data: { worker_type: 'codex' } })],
      ['a non-object payload', axiosFailure(400, { status: 'FAIL', data: 'nope' })],
      ['a plain client-side error', new Error('offline')],
      ['a network failure with no response', { status: 0 }],
      ['null', null],
      ['undefined', undefined],
    ])('%s', (_label, error) => {
      expect(capabilityErrorFrom(error)).toBeNull();
    });
  });
});
