import { i18n } from '@lingui/core';
import { t } from '@lingui/core/macro';
import { cloudManager, HubConnectionStatus, HubLoginStatus, User } from '@sdk';
import { useCloudStatus, useContext } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { notify } from '@src/notifications';
import { Chip } from '../label-chip';
import { OrganizationChip } from './organization-chip';
import { useLingui, Trans } from '@lingui/react/macro';
import { CONNECTION_VISUAL, LOGIN_VISUAL, type BadgeVisual } from './hub-status-visuals';

interface UserInfoProps {
  user: User;
}

type ButtonAction = 'sign_in' | 'reconnect' | 'verify' | 'disconnect' | null;

function computeButton(
  login: HubLoginStatus,
  connection: HubConnectionStatus,
): { label: string; action: ButtonAction; disabled: boolean; busy: boolean } {
  if (login === 'logged_out' || login === 'login_failed') {
    return { label: t`Sign in`, action: 'sign_in', disabled: false, busy: false };
  }
  if (login === 'logging_in') {
    return { label: t`Signing in…`, action: null, disabled: true, busy: true };
  }
  // login === 'logged_in'
  if (connection === 'connecting') {
    return { label: t`Connecting…`, action: null, disabled: true, busy: true };
  }
  if (connection === 'verified') {
    return { label: t`Disconnect`, action: 'disconnect', disabled: false, busy: false };
  }
  if (connection === 'connected') {
    return { label: t`Verify`, action: 'verify', disabled: false, busy: false };
  }
  // disconnected | error | auth_rejected
  return { label: t`Reconnect`, action: 'reconnect', disabled: false, busy: false };
}

export function UserInfo({ user }: UserInfoProps) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const { version } = useContext();
  const { login, connection, cloudUrl, connectionControlsAvailable } = useCloudStatus();

  const loginVisual = LOGIN_VISUAL[login.status];
  const connectionVisual = CONNECTION_VISUAL[connection.status];
  const button = computeButton(login.status, connection.status);
  const buttonBusy = button.busy || busy;
  const LoginIcon = loginVisual.icon;
  const ConnectionIcon = connectionVisual.icon;

  const runAction = async (action: ButtonAction) => {
    if (!action) return;
    setBusy(true);
    try {
      if (action === 'sign_in') {
        await cloudManager.login();
        notify.success({ title: t`Signed in`, id: 'cloud-conn-action' });
      } else if (action === 'reconnect') {
        const result = await cloudManager.connectHubWs();
        if (result.hub_ws_verified) {
          notify.success({
            title: t`Reconnected`,
            message: t`Hub WebSocket profile verified.`,
            id: 'cloud-conn-action',
          });
        } else {
          notify.success({ title: t`Connected`, message: t`Hub WebSocket connected.`, id: 'cloud-conn-action' });
        }
      } else if (action === 'verify') {
        const result = await cloudManager.verifyHubWs();
        if (result.hub_ws_verified) {
          notify.success({ title: t`Verified`, message: t`Hub WebSocket profile matches.`, id: 'cloud-conn-action' });
        }
      } else if (action === 'disconnect') {
        await cloudManager.disconnectHubWs();
        notify.success({
          title: t`Disconnected`,
          message: t`Hub WebSocket listener stopped.`,
          id: 'cloud-conn-action',
        });
      }
    } catch (err) {
      notify.error({
        title: t`${button.label} failed`,
        message: err instanceof Error ? err.message : t`Unknown error.`,
        id: 'cloud-conn-action',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCopyUserId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopyEmail = async () => {
    if (!user.email) return;
    try {
      await navigator.clipboard.writeText(user.email);
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">
          <Trans>Name:</Trans>
        </label>
        <div className="text-base">{user.displayName}</div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">
          <Trans>Email:</Trans>
        </label>
        <div className="flex items-center gap-2">
          <div className="min-w-0 break-all text-base">{user.email || t`N/A`}</div>
          {user.email && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 flex-shrink-0"
              onClick={() => {
                void handleCopyEmail();
              }}
            >
              {copiedEmail ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">
          <Trans>User ID:</Trans>
        </label>
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-muted-foreground">{user.id}</div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              void handleCopyUserId();
            }}
          >
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label className="text-sm font-semibold text-muted-foreground">
              <Trans>Flowpad Cloud:</Trans>
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={loginVisual.variant} className="gap-1">
                <LoginIcon className={`h-3 w-3 ${loginVisual.iconClassName ?? ''}`.trim()} />
                {i18n._(loginVisual.text)}
              </Badge>
              <Badge variant={connectionVisual.variant} className="gap-1">
                <ConnectionIcon className={`h-3 w-3 ${connectionVisual.iconClassName ?? ''}`.trim()} />
                {i18n._(connectionVisual.text)}
              </Badge>
            </div>
            {cloudUrl && (
              <div className="mt-1 break-all text-xs text-muted-foreground">
                <Trans>Hub: {cloudUrl}</Trans>
              </div>
            )}
          </div>
          {connectionControlsAvailable && (
            <Button
              variant={button.action === 'disconnect' ? 'outline' : 'default'}
              size="sm"
              disabled={button.disabled || buttonBusy}
              onClick={() => {
                void runAction(button.action);
              }}
            >
              {buttonBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {/* Already localized: `computeButton` resolves it with `t` at render time. */}
              {button.label}
            </Button>
          )}
        </div>

        {connection.status === 'auth_rejected' && (
          <div className="text-xs text-destructive">{connection.error ?? t`The hub refused this client.`}</div>
        )}
        {connection.status === 'error' && connection.error && (
          <div className="text-xs text-destructive">{connection.error}</div>
        )}
        {login.status === 'login_failed' && login.reason && (
          <div className="text-xs text-destructive">
            <Trans>Login: {login.reason}</Trans>
          </div>
        )}
      </div>

      {user.organization_id && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">
            <Trans>Organization:</Trans>
          </label>
          <div className="flex flex-wrap gap-2">
            <OrganizationChip orgId={user.organization_id} role={user.organization_role} />
          </div>
        </div>
      )}

      {user.picture && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">
            <Trans>Profile Picture:</Trans>
          </label>
          <img src={user.picture} alt={t`Profile`} className="h-16 w-16 rounded-full border-2 object-cover" />
        </div>
      )}

      {user.last_login && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">
            <Trans>Last Login:</Trans>
          </label>
          <div className="text-base">{new Date(user.last_login).toLocaleString()}</div>
        </div>
      )}

      {version && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">
            <Trans>Version:</Trans>
          </label>
          <div className="font-mono text-sm text-muted-foreground">v{version}</div>
        </div>
      )}

      {user.labels && user.labels.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">
            <Trans>Labels:</Trans>
          </label>
          <div className="flex flex-wrap gap-2">
            {user.labels.map((label) => (
              <Chip key={label} label={label} selected={false} onClick={() => {}} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
