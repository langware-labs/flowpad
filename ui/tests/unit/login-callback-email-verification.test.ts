import { resolveLoginCallbackUrl } from '@sdk/services/login_callback';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The invite → signup → verify-email round trip, which loses its destination
 * unless this function hands it back.
 *
 * Reproduced from a staging trace: a brand-new invitee's accept url rode
 * `target_path` all the way to `email-verification.html`, which stored it — and
 * then the login that followed Auth0's verification link used the app root Auth0
 * returns everyone to, dropping the invitee on hub home with a role nothing had
 * told them about.
 */

/** The address Auth0's verification link returns to. Tenant-wide, so it never
 *  names the invitation. Same-origin here because jsdom refuses to be navigated
 *  across origins; only the query string is load-bearing. */
const VERIFIED_RETURN =
  '/?supportSignUp=true&message=Your%20email%20was%20verified.%20You%20can%20continue%20using%20the%20application.&success=true&code=success';

/** The second click on the same verification link. `success` is present here
 *  too — as `false`. */
const ALREADY_USED_RETURN = '/?message=This%20URL%20can%20be%20used%20only%20once&success=false';

const ACCEPT_URL =
  'https://staging.flowpad.ai/api/v1/graph/members/accept?invitation-id=ebc4e28c-3e2e-465a-9c69-8107e333486b';

function standingOn(pathAndQuery: string) {
  window.history.replaceState(null, '', pathAndQuery);
}

beforeEach(() => {
  localStorage.clear();
  standingOn('/dock/hub/home');
});

describe('resolveLoginCallbackUrl', () => {
  it('records where the caller was, so a verification detour can come back', () => {
    expect(resolveLoginCallbackUrl(ACCEPT_URL)).toBe(ACCEPT_URL);
    expect(localStorage.getItem('loginCallbackUrl')).toBe(ACCEPT_URL);
  });

  it('returns the recorded destination instead of the root Auth0 came back to', () => {
    resolveLoginCallbackUrl(ACCEPT_URL);

    standingOn(VERIFIED_RETURN);
    // What the hub SPA passes in: its own pathname+search, which is the root.
    expect(resolveLoginCallbackUrl('/?supportSignUp=true&success=true&code=success')).toBe(ACCEPT_URL);
  });

  it('survives a second reader on the same page load', () => {
    // The regression this file exists for. More than one caller asks for a login
    // URL on the verification return, and consuming the entry on first read gave
    // the second one nothing — so the caller that actually navigated fell back
    // to the app root and the invitee landed on hub home. Verified in production:
    // the entry was present on the verify screen and gone from the same origin
    // afterwards, with the redirect carrying the root.
    resolveLoginCallbackUrl(ACCEPT_URL);
    standingOn(VERIFIED_RETURN);

    expect(resolveLoginCallbackUrl('/')).toBe(ACCEPT_URL);
    expect(resolveLoginCallbackUrl('/')).toBe(ACCEPT_URL);
    expect(localStorage.getItem('loginCallbackUrl')).toBe(ACCEPT_URL);
  });

  it('lets the next ordinary load overwrite the destination, so it cannot go stale', () => {
    resolveLoginCallbackUrl(ACCEPT_URL);
    standingOn(VERIFIED_RETURN);
    resolveLoginCallbackUrl('/');

    // An ordinary page, no Auth0 banner params: records itself over the old one.
    standingOn('/dock/hub/home');
    resolveLoginCallbackUrl('/dock/hub/home');
    expect(localStorage.getItem('loginCallbackUrl')).toBe('/dock/hub/home');
  });

  it('falls back to the caller when nothing was recorded', () => {
    standingOn(VERIFIED_RETURN);
    expect(resolveLoginCallbackUrl('/dock/hub/home')).toBe('/dock/hub/home');
  });

  it('does not consume the destination on the "URL can be used only once" bounce', () => {
    resolveLoginCallbackUrl(ACCEPT_URL);

    // `success=false` — a bare presence check reads this as a completed
    // verification and burns the stored destination on the one load that must
    // keep it, since the real verification tab is still to come.
    standingOn(ALREADY_USED_RETURN);
    resolveLoginCallbackUrl('/?message=This%20URL%20can%20be%20used%20only%20once&success=false');

    standingOn(VERIFIED_RETURN);
    expect(resolveLoginCallbackUrl('/')).toBe(ACCEPT_URL);
  });
});
