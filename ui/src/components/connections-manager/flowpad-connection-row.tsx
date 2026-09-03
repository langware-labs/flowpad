import * as React from 'react';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCloudStatus } from '@sdk/react/hooks';
import { cloudManager } from '@sdk';
import { hubStatusVisual } from '../account/hub-status-visuals';
import flowpadIcon from '@src/assets/flowpad-icon.png';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { TableCell, TableRow } from '../ui/table';

/**
 * FlowPad's own account, as a row in the Connections table.
 *
 * It is a connection like any other — it is the one this app signs in with — so
 * it belongs in the one table rather than in a screen of its own. That is the
 * whole requirement: show it with its status, and let opening it invoke the
 * FlowPad login.
 *
 * A THIRD row producer, not a synthetic entry in `allConnections`. The OAuth
 * rows read their status from `grantStatuses`, a map derived from the user's env
 * table and keyed by provider name; `flowpad_cloud` is not a registered OAuth
 * provider and has no row there, so a fake entry would read "Not connected"
 * forever no matter who is logged in. The table already composes two independent
 * producers into one `<TableBody>` (the OAuth map and `CredentialConnectionRows`),
 * so a third is the existing shape rather than a special case.
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
  const statusText = signingIn ? t`Signing in…` : i18n._(visual.text);
  const healthy = visual.variant === 'secondary';

  /** Who this machine is signed in as — the one fact a status word cannot carry. */
  const account = [cloudUrl, typeof login.user?.email === 'string' ? login.user.email : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <TableRow data-testid="connection-row-flowpad">
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <img src={flowpadIcon} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
          <span>FlowPad</span>
        </div>
      </TableCell>

      <TableCell>
        {/* Not "OAuth": the OAuth rows' `grantLabel` would describe hub login
            as an authorization-code grant, which it is not. */}
        <Badge
          variant="outline"
          className="text-xs font-normal"
          title={cloudUrl || t`Your FlowPad account`}
          data-testid="connection-kind-flowpad"
        >
          <Trans>FlowPad</Trans>
        </Badge>
      </TableCell>

      {/* Machine-level, not project-scoped: it asks for no per-project scopes
          and is not attached to a project, so both columns are honestly empty. */}
      <TableCell className="text-sm text-muted-foreground">—</TableCell>

      <TableCell>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              healthy ? 'bg-emerald-500' : loggedIn ? 'bg-amber-500' : 'bg-muted-foreground/40',
            )}
          />
          <span
            className={cn('whitespace-nowrap', healthy && 'text-emerald-600')}
            title={account || undefined}
            data-testid="connection-status-flowpad"
          >
            {statusText}
          </span>
        </div>
      </TableCell>

      <TableCell className="text-sm text-muted-foreground">—</TableCell>

      {/* Sign in, or sign out — the account's own lifecycle and nothing more.
          Reconnect / Verify / Disconnect are hub-WEBSOCKET controls, desktop-only
          (`connectionControlsAvailable`), and `account/user-info.tsx` already
          models all 4 login × 6 connection states around them; a lossy copy of
          three of six belongs here even less than none. */}
      <TableCell className="text-end">
        {loggedIn ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7"
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
      </TableCell>
    </TableRow>
  );
}
