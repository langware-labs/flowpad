import * as React from 'react';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCloudStatus } from '@sdk/react/hooks';
import { cloudManager } from '@sdk';
import { hubStatusVisual, LOGIN_VISUAL } from '../account/hub-status-visuals';
import flowpadIcon from '@src/assets/flowpad-icon.png';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { Button } from '../ui/button';
import { TableCell, TableRow } from '../ui/table';
import { SignInMethodIcon } from './sign-in-method';
import { MachineWideCell, TextActionCell } from './machine-wide-cell';

/**
 * FlowPad's own account, as a row in the Connections table.
 *
 * It is a connection like any other — it is the one this app signs in with — so
 * it belongs in the one table rather than in a screen of its own. That is the
 * whole requirement: show it with its status, and let opening it invoke the
 * FlowPad login.
 *
 * Its own row producer, not a synthetic entry in `allConnections`. The OAuth rows
 * read their status from `grantStatuses`, a map derived from the user's env table
 * and keyed by provider name; `flowpad_cloud` is not a registered OAuth provider
 * and has no row there, so a fake entry would read "Not connected" forever no
 * matter who is logged in. This `<TableBody>` composes several independent
 * producers, so one more is the existing shape rather than a special case.
 */
export function FlowpadConnectionRow() {
  const { t } = useLingui();
  const { login, connection, cloudUrl } = useCloudStatus();
  const [busy, setBusy] = React.useState(false);

  const loggedIn = login.status === 'logged_in';

  /**
   * Connect is awaited HERE rather than routed through `useOAuthConnection`.
   *
   * `oauthService.connect('flowpad_cloud')` delegates to `cloudManager.login()`
   * and returns `null`, and the hub's completion message is filtered out of
   * `onOAuthMessage` because no flow was registered for it — so
   * `OAUTH_FLOW_COMPLETE` never fires, and the hook's only success path for
   * clearing `connectingConnectionId` never runs. A row driven that way would
   * sit on "Waiting for approval…" with every button disabled for the life of
   * the mount. Owning the busy state locally sidesteps that entirely.
   */
  const connect = async () => {
    setBusy(true);
    try {
      await cloudManager.login();
    } catch (error) {
      notify.error({
        title: t`Could not sign in to FlowPad`,
        message: errorMessage(error, t`The login did not complete.`),
      });
    } finally {
      setBusy(false);
    }
  };

  /** Sign out, as-is: `cloudManager.logout()` is the whole action. */
  const logout = async () => {
    setBusy(true);
    try {
      await cloudManager.logout();
    } catch (error) {
      notify.error({
        title: t`Could not sign out of FlowPad`,
        message: errorMessage(error, t`The logout did not complete.`),
      });
    } finally {
      setBusy(false);
    }
  };

  // The status word comes from the SHARED hub-status table, not a second copy:
  // `user-info.tsx` renders the same two enums, and an if-ladder here had
  // already drifted from it on two states — and would have swallowed a new one
  // silently instead of failing to compile.
  const visual = hubStatusVisual(login.status, connection.status);
  const signingIn = busy || login.status === 'logging_in';
  // The table's vocabulary, not the account menu's: every other row says
  // "Connected" / "Not connected", so "Connection verified" and "Logged out"
  // read as two more states. The hub's own finer word moves to the tooltip.
  const healthy = loggedIn && (connection.status === 'verified' || connection.status === 'connected');
  const statusText = signingIn
    ? t`Signing in…`
    : healthy
      ? t`Connected`
      : login.status === 'logged_out'
        ? t`Not connected`
        : i18n._(visual.text);
  // The dot is the shared table's too; `busy` covers the moment before the hub
  // reports `logging_in`.
  const dot = signingIn ? LOGIN_VISUAL.logging_in.dot : visual.dot;
  const failed = visual.variant === 'destructive';

  const email = typeof login.user?.email === 'string' ? login.user.email : null;
  /** Who this machine is signed in as — the one fact a status word cannot carry. */
  const account = [healthy ? i18n._(visual.text) : null, cloudUrl, email].filter(Boolean).join(' · ');

  return (
    <TableRow data-testid="connection-row-flowpad">
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <img src={flowpadIcon} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
          <span>FlowPad</span>
        </div>
      </TableCell>

      <TableCell>
        {/* A browser sign-in to the hub. The address and account go in the tooltip. */}
        <SignInMethodIcon
          method="oauth"
          lines={[
            t`Signed in through your browser`,
            email,
            cloudUrl,
          ]}
          testId="connection-kind-flowpad"
        />
      </TableCell>

      {/* Machine-level: it asks for no per-project scopes, so Access requested is
          empty, and Used by says every project rather than "—". */}
      <TableCell className="text-sm text-muted-foreground">—</TableCell>

      <TableCell>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', dot)}
          />
          <span
            className={cn('whitespace-nowrap', failed && 'text-red-600 dark:text-red-500')}
            title={account || undefined}
            data-testid="connection-status-flowpad"
          >
            {statusText}
          </span>
        </div>
      </TableCell>

      <MachineWideCell />

      {/* Sign in, or sign out — the account's own lifecycle and nothing more.
          Reconnect / Verify / Disconnect are hub-WEBSOCKET controls, desktop-only
          (`connectionControlsAvailable`), and `account/user-info.tsx` already
          models all 4 login × 6 connection states around them; a lossy copy of
          three of six belongs here even less than none. */}
      <TextActionCell>
        {loggedIn ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={() => void logout()}
            data-testid="connection-flowpad-logout"
          >
            {busy ? <Trans>Signing out…</Trans> : <Trans>Logout</Trans>}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7"
            disabled={signingIn}
            onClick={() => void connect()}
            data-testid="connection-flowpad-connect"
          >
            {signingIn ? <Trans>Signing in…</Trans> : <Trans>Connect</Trans>}
          </Button>
        )}
      </TextActionCell>
    </TableRow>
  );
}
