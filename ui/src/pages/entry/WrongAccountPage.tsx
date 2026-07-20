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
 */
const WrongAccountPage: React.FC = () => {
  const callbackUrl = new URLSearchParams(window.location.search).get('callback') ?? undefined;
  return <WrongAccountPanel callbackUrl={callbackUrl} />;
};

export default WrongAccountPage;
