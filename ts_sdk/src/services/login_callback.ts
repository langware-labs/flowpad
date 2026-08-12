/**
 * Where a login has to return to, across the email-verification round trip.
 *
 * Signing up for the first time is not one redirect, it is two, and the second
 * one is not ours. A brand-new invitee clicking an emailed invite goes
 *
 *   members/accept → /api/v1/login?target_path=<accept url> → Auth0
 *     → callback: "access_denied: Please verify your email"
 *     → /email-verification.html?target_path=<accept url>
 *
 * and stops there, because the next click happens in their mailbox. That click
 * is Auth0's own verification link, which returns to the tenant-wide "Redirect
 * To" — the app ROOT, carrying `?success=true&message=Your email was verified…`.
 * Nothing in that URL remembers the invitation, and nothing can: it is one fixed
 * setting shared by every account that ever signs up.
 *
 * So the destination is written down before the trip (by `email-verification.html`,
 * which stores its `target_path`) and read back here on the way in. This module
 * owns both halves and nothing else, so the two callers that need it —
 * `navigationService.getLoginWithCallbackUrl` (desktop) and
 * `cloudManager._hubLoginUrl` (hub web) — can share it without importing each
 * other; they already form a cycle in the other direction.
 */

const STORAGE_KEY = 'loginCallbackUrl';

/**
 * Whether THIS page load is Auth0 handing the user back after they verified.
 *
 * Both halves are required. `success` alone also arrives as `success=false` on
 * the "This URL can be used only once" bounce (a second click on the same
 * verification link), which is emphatically not a completed verification —
 * reading it as a bare presence check would consume the stored destination on
 * the one load that must not have it.
 */
function isEmailVerificationReturn(): boolean {
  const params = new URL(document.location.href).searchParams;
  const message = params.get('message') || '';
  return params.get('success') === 'true' && message.includes('email') && message.includes('verified');
}

/**
 * Whether this page is one of Auth0's result banners rather than somewhere the
 * user meant to be — `?success=…&message=…`, which it appends to the tenant's
 * fixed redirect for every outcome ("Your email was verified", "This URL can be
 * used only once", …).
 *
 * Such a page is never a destination, so it must not be RECORDED as one. The
 * failure it prevents is a second click on the verification link, which loads a
 * "can be used only once" banner: that load is not a verification return, so
 * without this it would fall into the record branch and overwrite the invitation
 * the real return still has to collect.
 */
function isAuthResultPage(): boolean {
  const params = new URL(document.location.href).searchParams;
  return params.has('success') && params.has('message');
}

/**
 * The `target_path` to hand the login endpoint, given where the caller is now.
 *
 * Ordinary load: `current` IS the destination, and it is also recorded, so a
 * verification detour started from here can find its way back. An Auth0 result
 * banner is the exception — see `isAuthResultPage`.
 *
 * Verification return: `current` is the app root Auth0 chose, which is exactly
 * the address the user did NOT ask for — return the recorded destination
 * instead, and clear it so a later login isn't dragged back to a stale one.
 */
export function resolveLoginCallbackUrl(current: string): string {
  if (!isEmailVerificationReturn()) {
    if (!isAuthResultPage()) localStorage.setItem(STORAGE_KEY, current);
    return current;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return current;
  localStorage.removeItem(STORAGE_KEY);
  return stored;
}
