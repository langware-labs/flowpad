import {
  cloudManager,
  HubConnectionStatus,
  HubLoginStatus,
  User,
} from '@sdk';
import { useCloudStatus, useContext } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { AlertCircle, Check, CheckCircle2, Cloud, CloudOff, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Chip } from '../label-chip';

interface UserInfoProps {
  user: User;
}

type BadgeVisual = {
  text: string;
  variant: 'destructive' | 'secondary' | 'outline';
  icon: typeof Loader2;
  iconClassName?: string;
};

const LOGIN_VISUAL: Record<HubLoginStatus, BadgeVisual> = {
  logged_in:    { text: 'Logged in',  variant: 'secondary', icon: CheckCircle2 },
  logging_in:   { text: 'Signing in', variant: 'outline',   icon: Loader2, iconClassName: 'animate-spin' },
  login_failed: { text: 'Login failed', variant: 'destructive', icon: AlertCircle },
  logged_out:   { text: 'Logged out', variant: 'outline',   icon: CloudOff },
};

const CONNECTION_VISUAL: Record<HubConnectionStatus, BadgeVisual> = {
  verified:      { text: 'Connection verified', variant: 'secondary',   icon: CheckCircle2 },
  connected:     { text: 'Connected',           variant: 'outline',     icon: Cloud },
  connecting:    { text: 'Connecting',          variant: 'outline',     icon: Loader2, iconClassName: 'animate-spin' },
  auth_rejected: { text: 'Connection rejected', variant: 'destructive', icon: AlertCircle },
  error:         { text: 'Connection error',    variant: 'destructive', icon: AlertCircle },
  disconnected:  { text: 'Not connected',       variant: 'outline',     icon: CloudOff },
};

type ButtonAction = 'sign_in' | 'reconnect' | 'verify' | 'disconnect' | null;

function computeButton(
  login: HubLoginStatus,
  connection: HubConnectionStatus,
): { label: string; action: ButtonAction; disabled: boolean; busy: boolean } {
  if (login === 'logged_out' || login === 'login_failed') {
    return { label: 'Sign in', action: 'sign_in', disabled: false, busy: false };
  }
  if (login === 'logging_in') {
    return { label: 'Signing in…', action: null, disabled: true, busy: true };
  }
  // login === 'logged_in'
  if (connection === 'connecting') {
    return { label: 'Connecting…', action: null, disabled: true, busy: true };
  }
  if (connection === 'verified') {
    return { label: 'Disconnect', action: 'disconnect', disabled: false, busy: false };
  }
  if (connection === 'connected') {
    return { label: 'Verify', action: 'verify', disabled: false, busy: false };
  }
  // disconnected | error | auth_rejected
  return { label: 'Reconnect', action: 'reconnect', disabled: false, busy: false };
}

export function UserInfo({ user }: UserInfoProps) {
  const [copied, setCopied] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const { version } = useContext();
  const { login, connection, cloudUrl } = useCloudStatus();

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
        toast.success('Signed in');
      } else if (action === 'reconnect') {
        const result = await cloudManager.connectHubWs();
        if (result.hub_ws_verified) {
          toast.success('Reconnected', { description: 'Hub WebSocket profile verified.' });
        } else {
          toast.success('Connected', { description: 'Hub WebSocket connected.' });
        }
      } else if (action === 'verify') {
        const result = await cloudManager.verifyHubWs();
        if (result.hub_ws_verified) {
          toast.success('Verified', { description: 'Hub WebSocket profile matches.' });
        }
      } else if (action === 'disconnect') {
        await cloudManager.disconnectHubWs();
        toast.success('Disconnected', { description: 'Hub WebSocket listener stopped.' });
      }
    } catch (err) {
      toast.error(button.label + ' failed', {
        description: err instanceof Error ? err.message : 'Unknown error.',
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
        <label className="text-sm font-semibold text-muted-foreground">Name:</label>
        <div className="text-base">{user.displayName}</div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">Email:</label>
        <div className="flex items-center gap-2">
          <div className="min-w-0 break-all text-base">{user.email || 'N/A'}</div>
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
        <label className="text-sm font-semibold text-muted-foreground">User ID:</label>
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
            <label className="text-sm font-semibold text-muted-foreground">Flowpad Cloud:</label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={loginVisual.variant} className="gap-1">
                <LoginIcon className={`h-3 w-3 ${loginVisual.iconClassName ?? ''}`.trim()} />
                {loginVisual.text}
              </Badge>
              <Badge variant={connectionVisual.variant} className="gap-1">
                <ConnectionIcon className={`h-3 w-3 ${connectionVisual.iconClassName ?? ''}`.trim()} />
                {connectionVisual.text}
              </Badge>
            </div>
            {cloudUrl && (
              <div className="mt-1 text-xs text-muted-foreground break-all">Hub: {cloudUrl}</div>
            )}
          </div>
          <Button
            variant={button.action === 'disconnect' ? 'outline' : 'default'}
            size="sm"
            disabled={button.disabled || buttonBusy}
            onClick={() => {
              void runAction(button.action);
            }}
          >
            {buttonBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            {button.label}
          </Button>
        </div>

        {connection.status === 'auth_rejected' && (
          <div className="text-xs text-destructive">
            {connection.error ?? 'The hub refused this client.'}
          </div>
        )}
        {connection.status === 'error' && connection.error && (
          <div className="text-xs text-destructive">{connection.error}</div>
        )}
        {login.status === 'login_failed' && login.reason && (
          <div className="text-xs text-destructive">Login: {login.reason}</div>
        )}
      </div>

      {user.picture && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Profile Picture:</label>
          <img src={user.picture} alt="Profile" className="h-16 w-16 rounded-full border-2 object-cover" />
        </div>
      )}

      {user.last_login && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Last Login:</label>
          <div className="text-base">{new Date(user.last_login).toLocaleString()}</div>
        </div>
      )}

      {version && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Version:</label>
          <div className="font-mono text-sm text-muted-foreground">v{version}</div>
        </div>
      )}

      {user.labels && user.labels.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-muted-foreground">Labels:</label>
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
