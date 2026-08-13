import { describe, expect, it } from 'vitest';

import { isMissingGitCredential } from '@src/lib/error-message';

/**
 * Which screen the recipient of a shared sandbox sees.
 *
 * A clone that failed for want of a credential gets "connect your GitHub", with a
 * button that fixes it. Everything else gets "ask whoever shared it" — which is
 * the right advice for a broken link and useless advice for a missing login, so
 * telling the two apart is the whole job of this predicate.
 *
 * It has to work on WORDING, not status: `clone_project` returns the git driver's
 * message verbatim under a 400, so a bad URL and a missing credential are
 * indistinguishable by code.
 */
describe('isMissingGitCredential', () => {
  // The real thing, verbatim from staging — the string this exists to recognise.
  const REAL = {
    response: {
      data: {
        message:
          "Git clone failed: Cloning into '/tmp/flowpad-clone-cdpf7agm/repo'...\n" +
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      },
    },
  };

  it('recognises the anonymous-clone failure a recipient actually hits', () => {
    expect(isMissingGitCredential(REAL)).toBe(true);
  });

  it('recognises a credential that exists but no longer works', () => {
    // Expired or revoked. Different cause, same fix, same button.
    expect(isMissingGitCredential(new Error('fatal: Authentication failed for https://github.com/o/r.git'))).toBe(true);
  });

  it('reads the message whatever shape the failure arrives in', () => {
    // An axios rejection, a bare envelope and a plain Error all reach the UI.
    expect(isMissingGitCredential({ message: 'could not read Username' })).toBe(true);
    expect(isMissingGitCredential({ detail: 'terminal prompts disabled' })).toBe(true);
  });

  it('is not fooled by case', () => {
    expect(isMissingGitCredential(new Error('Could Not Read Username'))).toBe(true);
  });

  // ── everything below must fall through to the ordinary error screen ──

  it('leaves a genuinely missing repo alone', () => {
    // The wrong-link case. Offering a GitHub connection here would send someone
    // through an OAuth round trip that cannot possibly help.
    expect(isMissingGitCredential(new Error("fatal: repository 'https://github.com/o/r.git/' not found"))).toBe(false);
  });

  it('leaves other clone failures alone', () => {
    expect(isMissingGitCredential(new Error('fatal: unable to access ...: Could not resolve host: github.com'))).toBe(
      false,
    );
    expect(isMissingGitCredential(new Error('error: RPC failed; curl 92 HTTP/2 stream 0 was not closed'))).toBe(false);
  });

  it('does not throw on the shapes that carry no message at all', () => {
    expect(isMissingGitCredential(null)).toBe(false);
    expect(isMissingGitCredential(undefined)).toBe(false);
    expect(isMissingGitCredential({})).toBe(false);
    expect(isMissingGitCredential('')).toBe(false);
  });
});
