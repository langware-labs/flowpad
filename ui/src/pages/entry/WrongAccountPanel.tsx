import { cloudManager, navigator as sdkNavigator } from '@sdk';
import React from 'react';
import './message-landing.css';

interface WrongAccountPanelProps {
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
const WrongAccountPanel: React.FC<WrongAccountPanelProps> = ({ callbackUrl, onBeforeSignIn }) => {
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
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Wrong account</h2>
        <p style={{ margin: '0 0 28px', fontSize: 15, color: '#444', lineHeight: 1.6 }}>
          This invitation was sent to a different email address. Please sign in with the correct account to view it.
        </p>
        <button className="nl-btn" style={{ display: 'inline-block', marginTop: 0 }} onClick={handleSignIn}>
          Sign in with the correct account
        </button>
      </div>
    </div>
  );
};

export default WrongAccountPanel;
