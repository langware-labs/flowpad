import { inboundParams } from '@src/navigation/inbound-link';
import React from 'react';
import WrongAccountPanel from './WrongAccountPanel';

/**
 * Full-screen route for /wrong_account. The hub's members/accept endpoint
 * redirects here (with ?callback=<accept-url>) when the signed-in user's email
 * doesn't match the invitation, so the browser shows the nice panel instead of
 * the raw 403 JSON. The callback is the server-built accept URL; signing in
 * with the correct account returns there and completes the invitation.
 *
 * The callback flows into the login redirect (target_path), which the backend
 * validates against the trusted-host allowlist (is_safe_redirect_target), so no
 * open-redirect guard is needed here.
 *
 * TWO SENDERS, and the callback is what tells them apart. `members/accept`
 * redirects here on an email mismatch and sets `callback` to its own accept URL —
 * a real wrong account. `wrong_account_page_for_navigation` (core/auth/authorizer)
 * redirects here when a caller who IS signed in holds no role on the entity they
 * followed a link to, and sets `callback` to that link. Its own docstring says
 * this is the common case: "the recipient's first click frequently arrives
 * AUTHENTICATED — as somebody who was never invited — and lands here." Showing
 * those people "Wrong account" points them at a problem they do not have.
 */
const WrongAccountPage: React.FC = () => {
  const callbackUrl = inboundParams().get('callback') ?? undefined;
  // Read on the PATH, not with a substring search over the whole URL: a node id
  // or a query value could contain anything, and only the accept route's own path
  // means "this was an invitation whose email did not match".
  const reason = isInvitationAccept(callbackUrl) ? 'wrong-account' : 'no-access';
  return <WrongAccountPanel reason={reason} callbackUrl={callbackUrl} />;
};

/** Whether `url` is the hub's `members/accept` route — the email-mismatch sender. */
function isInvitationAccept(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url, window.location.origin).pathname.endsWith('/members/accept');
  } catch {
    return false;
  }
}

export default WrongAccountPage;
