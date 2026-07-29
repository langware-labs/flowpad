import {
  ConnectionStatus,
  TypeId,
  type OAuthConnection,
  type OAuthDetachResult,
  type OAuthFlowKind,
} from '@sdk';
import { CheckCircle } from 'lucide-react';
import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useOAuthConnection } from '@sdk/react/hooks/useOAuthConnection';
import { cn } from '@src/lib/utils';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useConnectionTimestamps } from './connections-manager/use-connection-timestamps';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { TooltipProvider } from './ui/tooltip';

export interface ConnectionsManagerProps {
  /**
   * The project an OAuth token attaches to. Connect and disconnect are
   * disabled without one — a token has to be granted TO something.
   */
  projectTypeId?: TypeId;
  className?: string;
  /** Render the "OAuth Connections" heading. */
  header?: boolean;
  onConnectionConnect?: (connectionId: string) => void;
  onConnectionDisconnect?: (connectionId: string, detachResult?: OAuthDetachResult) => void;
}

// Extended OAuth connection type that includes providerName for internal use
interface ExtendedOAuthConnection extends OAuthConnection {
  providerName: string;
  kind?: OAuthFlowKind;
  scopes?: string[];
}

/** What each grant asks of the user, in their terms — the column is only worth a
 *  row's width if it says something they can act on. */
const FLOW_KIND_LABEL: Record<OAuthFlowKind, { label: string; hint: string }> = {
  code: { label: 'OAuth', hint: 'Authorization code — you approve in the browser and come back' },
  loopback: { label: 'OAuth + PKCE', hint: 'Authorization code with PKCE, redirected back to this machine' },
  device: { label: 'Device code', hint: 'You type a short code into the provider’s site' },
};

export const ConnectionsManager: React.FC<ConnectionsManagerProps> = ({
  projectTypeId,
  className,
  header = true,
  onConnectionConnect,
  onConnectionDisconnect,
}) => {
  const { t } = useLingui();
  const { timestamps: connectionTimestamps, record, forget } = useConnectionTimestamps();

  // Handle OAuth authentication success (auth completed, auto-attached)
  const handleOAuthAuthSuccess = React.useCallback(
    (connectionId: string) => {
      onConnectionConnect?.(connectionId);
    },
    [onConnectionConnect],
  );

  // Handle OAuth attach success (connection is now fully connected)
  const handleOAuthAttachSuccess = React.useCallback(
    (connectionId: string) => {
      record(connectionId);
      onConnectionConnect?.(connectionId);
    },
    [onConnectionConnect, record],
  );

  // Handle OAuth connection disconnect
  const handleOAuthDisconnect = React.useCallback(
    (connectionId: string, detachResult?: OAuthDetachResult) => {
      forget(connectionId);
      onConnectionDisconnect?.(connectionId, detachResult);
    },
    [onConnectionDisconnect, forget],
  );

  const {
    connectingConnectionId,
    availableProviders,
    connectionStatuses: providerStatuses,
    connect,
    attach,
    detach,
  } = useOAuthConnection({
    projectTypeId,
    onConnectionDisconnect: handleOAuthDisconnect,
    onOAuthAuthSuccess: handleOAuthAuthSuccess, // OAuth auth completed (status: AVAILABLE)
    onAttachSuccess: handleOAuthAttachSuccess, // Attach completed (status: CONNECTED)
  });

  // Create connections from available providers with their statuses
  const allConnections: ExtendedOAuthConnection[] = React.useMemo(() => {
    return availableProviders.map((provider) => ({
      id: provider.name.toLowerCase(),
      provider: provider.display_name,
      providerName: provider.name, // Keep the actual provider name for API calls
      status: providerStatuses[provider.name] || ConnectionStatus.DISCONNECTED,
      connectedAt: connectionTimestamps[provider.name.toLowerCase()],
      kind: provider.kind,
      scopes: provider.scopes,
    }));
  }, [availableProviders, providerStatuses, connectionTimestamps]);

  const handleConnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;
    // Check if we have a current project
    if (!projectTypeId) {
      notify.error({
        title: t`No project selected`,
        message: t`Pick a project first — an OAuth token is granted to a project, not to the app.`,
      });
      return;
    }

    try {
      const currentStatus = connection.status;
      const providerName = connection.providerName || connection.provider.toLowerCase();

      if (currentStatus === ConnectionStatus.DISCONNECTED) {
        // No OAuth token exists, start full OAuth flow
        await connect(connectionId, providerName);
      } else {
        // OAuth token exists (AVAILABLE/CONNECTED), just attach to current project
        await attach(connectionId, providerName);
      }
    } catch (error) {
      // Surfaced, not just logged: every failure here (no token yet, a provider
      // this instance cannot complete a flow for, a backend refusal) used to
      // land in the console only, so the button looked like it did nothing.
      notify.error({
        title: t`${connection.provider} connection failed`,
        message: errorMessage(error, t`Could not connect to ${connection.provider}.`),
      });
    }
  };

  const handleDisconnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;

    try {
      const providerName = connection.providerName || connection.provider.toLowerCase();
      // Status 3: Detach from current project
      await detach(connectionId, providerName);
    } catch (error) {
      notify.error({
        title: t`${connection.provider} disconnect failed`,
        message: errorMessage(error, t`Could not disconnect from ${connection.provider}.`),
      });
    }
  };

  const formatConnectionDate = (date?: Date) => {
    if (!date) return t`Never connected`;

    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    // Show relative time for recent connections
    if (diffInSeconds < 60) {
      return t`Just now`;
    } else if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    } else if (diffInSeconds < 86400) {
      const hours = Math.floor(diffInSeconds / 3600);
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    } else if (diffInSeconds < 604800) {
      const days = Math.floor(diffInSeconds / 86400);
      return `${days} day${days === 1 ? '' : 's'} ago`;
    } else {
      // Show full date for older connections
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
  };

  return (
    // No frame of its own — the host supplies height and padding.
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="connections-manager">
      <div className="mb-4">
        {header && (
          <h2 className="text-xl font-semibold">
            <Trans>OAuth Connections</Trans>
          </h2>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]"><Trans>Provider</Trans></TableHead>
              <TableHead className="w-[130px]"><Trans>Sign-in</Trans></TableHead>
              <TableHead><Trans>Access requested</Trans></TableHead>
              <TableHead className="w-[220px]"><Trans>Status</Trans></TableHead>
              <TableHead className="w-[150px]"><Trans>Actions</Trans></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allConnections.map((connection) => {
              return (
                <TableRow key={connection.id}>
                  <TableCell className="w-[200px]">
                    <div className="flex items-center gap-2 align-middle">
                      {(() => {
                        // Case-insensitive provider lookup
                        const provider = availableProviders.find(
                          (p) => p.name.toLowerCase() === connection.provider.toLowerCase(),
                        );
                        const iconUrl = provider?.icon;
                        return iconUrl ? (
                          <img
                            src={iconUrl}
                            alt={t`${connection.provider} icon`}
                            className="h-5 w-5 flex-shrink-0"
                            onError={(e) => {
                              // Hide the image if it fails to load
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : null;
                      })()}
                      <span className="align-middle">{connection.provider}</span>
                    </div>
                  </TableCell>

                  <TableCell className="w-[130px]" data-testid={`connection-kind-${connection.id}`}>
                    {connection.kind ? (
                      <span
                        className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                        title={FLOW_KIND_LABEL[connection.kind].hint}
                      >
                        {FLOW_KIND_LABEL[connection.kind].label}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/60">—</span>
                    )}
                  </TableCell>

                  <TableCell data-testid={`connection-scopes-${connection.id}`}>
                    {connection.scopes?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {connection.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                          >
                            {scope}
                          </span>
                        ))}
                      </div>
                    ) : (
                      // Not "no scopes" — the side that owns the flow did not
                      // publish them. Saying "none" would be a lie.
                      <span className="text-xs text-muted-foreground/60">
                        <Trans>Shown at approval</Trans>
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="w-[220px]">
                    <TooltipProvider>
                      <div className="flex items-center gap-2">
                        {connection.status === ConnectionStatus.CONNECTED ? (
                          <>
                            <CheckCircle className="h-4 w-4 text-green-600" />
                            <span className="text-green-600"><Trans>Connected</Trans></span>
                            {connection.connectedAt && (
                              <span className="text-gray-500">- {formatConnectionDate(connection.connectedAt)}</span>
                            )}
                          </>
                        ) : connection.status === ConnectionStatus.AVAILABLE ? (
                          <>
                            <div className="h-4 w-4 rounded-full border-2 border-gray-400 flex items-center justify-center">
                              <div className="h-2 w-2 rounded-full bg-gray-400" />
                            </div>
                            <span className="text-gray-500"><Trans>Ready to Connect</Trans></span>
                          </>
                        ) : (
                          <>
                            <div className="h-4 w-4 rounded-full border-2 border-gray-400 flex items-center justify-center">
                              <div className="h-2 w-2 rounded-full bg-gray-400" />
                            </div>
                            <span className="text-gray-500"><Trans>Disconnected</Trans></span>
                          </>
                        )}
                      </div>
                    </TooltipProvider>
                  </TableCell>
                  <TableCell className="w-[150px]">
                    <Button
                      variant={connection.status === ConnectionStatus.CONNECTED ? 'outline' : 'default'}
                      onClick={() => {
                        if (connection.status === ConnectionStatus.CONNECTED) {
                          void handleDisconnect(connection.id);
                        } else {
                          void handleConnect(connection.id);
                        }
                      }}
                      disabled={connectingConnectionId === connection.id}
                      className={
                        connection.status === ConnectionStatus.CONNECTED
                          ? 'text-blue-600 hover:text-blue-700 w-[110px]'
                          : 'w-[110px]'
                      }
                    >
                      {connectingConnectionId === connection.id
                        ? t`Connecting...`
                        : connection.status === ConnectionStatus.CONNECTED
                          ? t`Disconnect`
                          : t`Connect`}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {allConnections.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-gray-500">
                  <Trans>No OAuth connections found</Trans>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
