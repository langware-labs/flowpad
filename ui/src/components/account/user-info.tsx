import { cloudManager, type CloudStatusData, User } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { AlertCircle, Check, CheckCircle2, Cloud, CloudOff, Copy, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Chip } from '../label-chip';

interface UserInfoProps {
  user: User;
}

type ConnectionDisplay = 'connecting' | 'verified' | 'connected' | 'error' | 'disconnected';

const CONNECTION_VISUAL: Record<ConnectionDisplay, {
  text: string;
  variant: 'destructive' | 'secondary' | 'outline';
  icon: typeof Loader2;
  iconClassName?: string;
}> = {
  connecting: { text: 'Connecting', variant: 'outline', icon: Loader2, iconClassName: 'animate-spin' },
  verified:   { text: 'Connection verified', variant: 'secondary', icon: CheckCircle2 },
  connected:  { text: 'Connected', variant: 'outline', icon: Cloud },
  error:      { text: 'Connection error', variant: 'destructive', icon: AlertCircle },
  disconnected: { text: 'Not connected', variant: 'outline', icon: CloudOff },
};

function connectionDisplay(status: CloudStatusData): ConnectionDisplay {
  if (status.hub_ws_status === 'connecting') return 'connecting';
  if (status.hub_ws_verified) return 'verified';
  if (status.hub_ws_connected) return 'connected';
  if (status.hub_ws_status === 'error') return 'error';
  return 'disconnected';
}

function cloudStatusEqual(a: CloudStatusData, b: CloudStatusData): boolean {
  return (
    a.logged_in === b.logged_in &&
    a.hub_ws_connected === b.hub_ws_connected &&
    a.hub_ws_verified === b.hub_ws_verified &&
    a.hub_ws_status === b.hub_ws_status &&
    a.hub_ws_error === b.hub_ws_error
  );
}

export function UserInfo({ user }: UserInfoProps) {
  const [copied, setCopied] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudStatusData>(cloudManager.cloudStatus);
  const [cloudBusy, setCloudBusy] = useState(false);
  const { version } = useContext();

  useEffect(() => {
    const sync = () => {
      const next = cloudManager.cloudStatus;
      setCloudStatus((prev) => (cloudStatusEqual(prev, next) ? prev : { ...next }));
    };
    cloudManager.on('cloud_status_changed', sync);
    void cloudManager.refreshStatus();
    return () => {
      cloudManager.off('cloud_status_changed', sync);
    };
  }, []);

  const isCloudLoggedIn = Boolean(cloudStatus.logged_in);
  const isConnecting = cloudBusy || cloudStatus.hub_ws_status === 'connecting';
  const display = useMemo(() => CONNECTION_VISUAL[connectionDisplay(cloudStatus)], [cloudStatus]);
  const Icon = display.icon;

  const handleCloudConnect = async () => {
    setCloudBusy(true);
    try {
      const result = await cloudManager.connectHubWs();
      if (result.hub_ws_verified) {
        toast.success('Connection verified', { description: 'Hub WebSocket profile matches this account.' });
      } else {
        toast.success('Connected', { description: 'Hub WebSocket connected but verification did not complete.' });
      }
    } catch (err) {
      toast.error('Hub WebSocket failed', {
        description: err instanceof Error ? err.message : 'Could not connect to hub WebSocket.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudDisconnect = async () => {
    setCloudBusy(true);
    try {
      await cloudManager.disconnectHubWs();
      toast.success('Disconnected', { description: 'Hub WebSocket listener stopped.' });
    } catch (err) {
      toast.error('Disconnect failed', {
        description: err instanceof Error ? err.message : 'Could not stop hub WebSocket.',
      });
    } finally {
      setCloudBusy(false);
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

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">Name:</label>
        <div className="text-base">{user.displayName}</div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-semibold text-muted-foreground">Email:</label>
        <div className="text-base">{user.email || 'N/A'}</div>
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
              <Badge variant={isCloudLoggedIn ? 'secondary' : 'outline'}>
                {isCloudLoggedIn ? 'Logged in' : 'Logged out'}
              </Badge>
              <Badge variant={display.variant} className="gap-1">
                <Icon className={`h-3 w-3 ${display.iconClassName ?? ''}`.trim()} />
                {display.text}
              </Badge>
            </div>
          </div>
          <Button
            variant={cloudStatus.hub_ws_connected || cloudStatus.hub_ws_verified ? 'outline' : 'default'}
            size="sm"
            disabled={!isCloudLoggedIn || isConnecting}
            onClick={() => {
              void (cloudStatus.hub_ws_connected || cloudStatus.hub_ws_verified
                ? handleCloudDisconnect()
                : handleCloudConnect());
            }}
            title={!isCloudLoggedIn ? 'Cloud login required before connecting hub WebSocket' : undefined}
          >
            {isConnecting && <Loader2 className="h-4 w-4 animate-spin" />}
            {cloudStatus.hub_ws_connected || cloudStatus.hub_ws_verified ? 'Disconnect' : 'Connect'}
          </Button>
        </div>

        {cloudStatus.hub_ws_verified && (
          <div className="text-xs font-medium text-green-600">Connection verified</div>
        )}
        {cloudStatus.hub_ws_error && (
          <div className="text-xs text-destructive">{cloudStatus.hub_ws_error}</div>
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
