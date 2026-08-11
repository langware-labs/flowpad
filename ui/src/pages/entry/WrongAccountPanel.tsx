import { cloudManager, navigator as sdkNavigator } from '@sdk';
import React from 'react';
import './message-landing.css';

/**
 * Which of the two refusals this is.
 *
 * The hub sends both to `/wrong_account`, and for one of them the name is a lie.
 * `members/accept` redirects here on an email MISMATCH — a genuinely wrong
 * account. `wrong_account_page_for_navigation` redirects here when a caller who
 * IS signed in holds no role on the thing they followed a link to, which is the
 * ordinary state of someone who was invited a minute ago and has not accepted
 * yet. Telling that person to sign in with a different account sends them to fix
 * something that is not broken; three separate staging sessions were lost to it.
 */
export type WrongAccountReason = 'wrong-account' | 'no-access';

interface WrongAccountPanelProps {
  /** Defaults to the historical message. See {@link WrongAccountReason}. */
  reason?: WrongAccountReason;
  /** Where to return after re-authenticating with the correct account.
   *  Defaults to the current URL (used by MessageLanding); the dedicated
   *  wrong-account route passes the server-provided invitation-accept URL so
   *  signing in with the right account completes the invitation. */
  callbackUrl?: string;
  /** Optional cleanup run just before navigating away (e.g. clearing a
   *  login-attempt marker). */
  onBeforeSignIn?: () => void;
}

/**
 * The "Wrong account" screen shown when the signed-in user is not the invitee.
 * Single source of truth for this panel: rendered by MessageLanding (message
 * 401s after a login attempt), InvitePage (domain refusal / wrong identity),
 * and the dedicated /wrong_account route (the hub's members/accept endpoint
 * redirects an email mismatch here instead of dumping raw JSON).
 *
 * Sign-in = logout WITH a returnTo of the login-with-callback URL, so the
 * whole chain is: logout (kills app + IdP session) → login (target_path =
 * callback) → the accept URL completes the invitation as the right account.
 * Routed through cloudManager.logout(returnTo) — the one seam that owns the
 * hub auth URLs.
 */
const WrongAccountPanel: React.FC<WrongAccountPanelProps> = ({
  reason = 'wrong-account',
  callbackUrl,
  onBeforeSignIn,
}) => {
  const noAccess = reason === 'no-access';
  const handleSignIn = () => {
    onBeforeSignIn?.();
    const loginUrl = sdkNavigator.getLoginWithCallbackUrl(callbackUrl ?? window.location.href);
    void cloudManager.logout(loginUrl);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f5f4ff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 2px 16px rgba(0,0,0,0.10)',
          padding: '48px 40px',
          maxWidth: 420,
          width: '90%',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 16 }}>🔒</div>
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>
          {noAccess ? 'You do not have access to this yet' : 'Wrong account'}
        </h2>
        <p style={{ margin: '0 0 28px', fontSize: 15, color: '#444', lineHeight: 1.6 }}>
          {noAccess
            ? 'If someone just invited you, open the invitation and accept it first. If you signed in with a different account than the one it was sent to, sign in again below.'
            : 'This invitation was sent to a different email address. Please sign in with the correct account to view it.'}
        </p>
        <button className="nl-btn" style={{ display: 'inline-block', marginTop: 0 }} onClick={handleSignIn}>
          {noAccess ? 'Sign in with a different account' : 'Sign in with the correct account'}
        </button>
      </div>
    </div>
  );
};

export default WrongAccountPanel;
