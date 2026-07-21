import { dismiss, notify } from '@src/notifications';
import { useCloudStatus } from '@sdk/react/hooks';
import { useEffect, useRef } from 'react';

/**
 * App-level cloud alerts. Turns the two cloud status slots into DISTINCT,
 * prominent pops so the user can tell apart failures that otherwise all just
 * read as "not signed in":
 *   - connection 'error'         → "Can't reach Flowpad Cloud" (hub down / unreachable)
 *   - connection 'auth_rejected' → session rejected, sign in again
 *   - login 'login_failed'       → the sign-in attempt itself failed
 *
 * A plain signed-out state stays QUIET on purpose (the footer sign-in affordance
 * handles it) — only genuine failures pop. Fires on transitions only (deduped by
 * a fixed toast id), and clears + confirms on recovery. Desktop-only: hub and
 * Local/privacy modes have no cloud layer (connectionControlsAvailable is false).
 */
export function useCloudAlerts(): void {
  const { login, connection, connectionControlsAvailable, cloudUrl } = useCloudStatus();
  const prevConn = useRef<string | null>(null);
  const prevLogin = useRef<string | null>(null);

  useEffect(() => {
    if (!connectionControlsAvailable) return;

    const c = connection.status;
    if (c !== prevConn.current) {
      if (c === 'error') {
        notify.error({
          id: 'cloud-connection',
          title: "Can't reach Flowpad Cloud",
          message: `The hub${cloudUrl ? ` (${cloudUrl})` : ''} may be down or unreachable.`,
        });
      } else if (c === 'auth_rejected') {
        notify.error({
          id: 'cloud-connection',
          title: 'Flowpad Cloud session rejected',
          message: 'Your session was rejected — please sign in again.',
        });
      } else if ((c === 'connected' || c === 'verified') && (prevConn.current === 'error' || prevConn.current === 'auth_rejected')) {
        dismiss('cloud-connection');
        notify.success({ title: 'Reconnected to Flowpad Cloud' });
      }
      prevConn.current = c;
    }

    if (login.status !== prevLogin.current) {
      if (login.status === 'login_failed') {
        notify.error({
          id: 'cloud-login',
          title: 'Sign-in failed',
          message: login.reason || 'Could not sign in to Flowpad Cloud.',
        });
      } else if (login.status === 'logged_in') {
        dismiss('cloud-login');
      }
      prevLogin.current = login.status;
    }
  }, [connection.status, login.status, login.reason, connectionControlsAvailable, cloudUrl]);
}
