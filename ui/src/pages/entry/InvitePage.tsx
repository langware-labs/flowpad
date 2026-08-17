import { navigator as sdkNavigator, redeemInviteLink } from '@sdk';
import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import WrongAccountPanel from './WrongAccountPanel';

/** What a redeem failure means to the person holding the link. A 200 never gets
 *  here — it navigates. */
function messageForStatus(status: number | undefined, detail: string | undefined): string {
  if (status === 404) return "This invite link doesn't exist.";
  // Revoked, expired, author gone, or the thing it pointed at was deleted — all
  // 410. They are one outcome to the reader: the link is dead.
  if (status === 410) return 'This invite link is no longer active.';
  // The author-lost-permission 403. (The domain 403 never reaches here — it
  // renders the account-switch panel instead.)
  if (status === 403) return detail ?? 'Ask whoever shared this for a new link.';
  return 'Something went wrong opening this invite link.';
}

/** The "not open to your email domain" 403 — the one failure the holder can fix
 *  themselves, by signing in as someone else. */
function isDomainRefusal(status: number | undefined, detail: string | undefined): boolean {
  return status === 403 && !!detail && /domain/i.test(detail);
}

/**
 * Full-screen route for `/invite/<token>` — where a shareable invite link lands.
 * Outside the workspace shell, like `/wrong_account` and `/flow_message/:id`:
 * the holder may not be a member of anything yet, so the shell has nothing to
 * show them.
 *
 * The client owns the login bounce. Redeem is authenticated-only with no public
 * carve-out by design, so an anonymous POST 401s — we bounce through login and
 * come back to this same URL. A `sessionStorage` marker stops a 401 that
 * *isn't* about being signed out (wrong identity) from looping through login
 * forever. The bounce uses `getLoginWithCallbackUrl` directly (the SDK's
 * `navigateToLogin` runs the desktop cloud flow and drops the target_path).
 *
 * The token rides as a path segment and then a POST body — never a query
 * string. Beyond keeping it out of logs, history and Referer, the hub's graph
 * router merges query params over the body, so a query param would silently
 * override the field.
 */
const InvitePage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [error, setError] = useState<{ status?: number; detail?: string } | null>(null);
  const [wrongAccount, setWrongAccount] = useState(false);
  // Redeem is idempotent hub-side, but StrictMode double-invokes effects — don't
  // fire a second pointless round-trip.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;

    const loginAttemptKey = `login-attempt-invite-${token}`;

    redeemInviteLink(token)
      .then(({ redirect_url }) => {
        // The server chose this and re-validated it against the open-redirect
        // check — don't compute a landing here. It's an absolute app URL, so
        // assign it rather than routing to it.
        window.location.href = redirect_url;
      })
      .catch((err: unknown) => {
        const e = err as {
          response?: { status?: number; data?: { detail?: string; message?: string } };
          status?: number;
          detail?: string;
        };
        const status = e?.response?.status ?? e?.status;
        // The hub's ApiFailResponse carries `message`; FastAPI HTTPExceptions
        // carry `detail`. Read both.
        const detail = e?.response?.data?.detail ?? e?.response?.data?.message ?? e?.detail;

        if (status === 401) {
          // Came back from login and still 401 → signed in as someone the hub
          // won't accept, not signed out. Bouncing again would loop.
          if (sessionStorage.getItem(loginAttemptKey)) {
            setWrongAccount(true);
            return;
          }
          sessionStorage.setItem(loginAttemptKey, '1');
          window.location.assign(sdkNavigator.getLoginWithCallbackUrl(window.location.href));
          return;
        }
        setError({ status, detail });
      });
  }, [token]);

  if (wrongAccount || (error && isDomainRefusal(error.status, error.detail))) {
    // Reuses the existing wrong-account screen: same problem (signed in as the
    // wrong identity), same fix, same callback back to this link.
    return <WrongAccountPanel callbackUrl={window.location.href} />;
  }

  return (
    // fixed inset-0, not min-h-screen: the shell renders this route inside a
    // shrink-to-fit flex parent, so a width-relative box collapses to a column.
    <div className="fixed inset-0 flex items-center justify-center overflow-auto bg-[#f5f4ff]">
      <div className="w-[90%] max-w-[420px] rounded-xl bg-white p-10 text-center shadow-lg">
        {error ? (
          <>
            <div className="mb-4 text-4xl">🔗</div>
            <h2 className="mb-3 text-xl font-bold text-[#1a1a2e]">Invite link</h2>
            <p className="text-[15px] leading-relaxed text-neutral-700">
              {messageForStatus(error.status, error.detail)}
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-5 h-12 w-12 animate-spin rounded-full border-b-2 border-neutral-400" />
            <p className="text-[15px] leading-relaxed text-neutral-700">Opening your invite…</p>
          </>
        )}
      </div>
    </div>
  );
};

export default InvitePage;
