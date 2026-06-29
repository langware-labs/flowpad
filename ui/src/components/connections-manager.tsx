import { ConnectionStatus, TypeId, type OAuthConnection, type OAuthDetachResult } from '@sdk';
import { CheckCircle } from 'lucide-react';
import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useOAuthConnection } from '@sdk/react/hooks/useOAuthConnection';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { TooltipProvider } from './ui/tooltip';

interface ConnectionsManagerProps {
  connections?: OAuthConnection[];
  onConnectionConnect?: (connectionId: string) => void;
  onConnectionDisconnect?: (connectionId: string, detachResult?: OAuthDetachResult) => void;
  currentProject?: TypeId;
}

// Extended OAuth connection type that includes providerName for internal use
interface ExtendedOAuthConnection extends OAuthConnection {
  providerName: string;
}

export const ConnectionsManager: React.FC<ConnectionsManagerProps> = ({
  onConnectionConnect,
  onConnectionDisconnect,
  currentProject,
}) => {
  const { t } = useLingui();
  const [connectionTimestamps, setConnectionTimestamps] = React.useState<Record<string, Date>>(() => {
    // Load from localStorage on initialization
    try {
      const saved = localStorage.getItem('oauth-connection-timestamps');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Convert string dates back to Date objects
        const result: Record<string, Date> = {};
        for (const [key, value] of Object.entries(parsed)) {
          result[key] = new Date(value as string);
        }
        return result;
      }
      return {};
    } catch {
      return {};
    }
  });

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
      const now = new Date();
      // Set the connection timestamp
      setConnectionTimestamps((prev) => ({
        ...prev,
        [connectionId]: now,
      }));

      onConnectionConnect?.(connectionId);
    },
    [onConnectionConnect],
  );

  // Handle OAuth connection disconnect
  const handleOAuthDisconnect = React.useCallback(
    (connectionId: string, detachResult?: OAuthDetachResult) => {
      setConnectionTimestamps((prev) => {
        const newTimestamps = { ...prev };
        delete newTimestamps[connectionId];
        return newTimestamps;
      });

      // Call the parent callback
      onConnectionDisconnect?.(connectionId, detachResult);
    },
    [onConnectionDisconnect],
  );

  const {
    connectingConnectionId,
    availableProviders,
    connectionStatuses: providerStatuses,
    connect,
    attach,
    detach,
  } = useOAuthConnection({
    currentProject,
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
    }));
  }, [availableProviders, providerStatuses, connectionTimestamps]);

  const handleConnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;
    // Check if we have a current project
    if (!currentProject) {
      console.error('[ConnectionsManager] ERROR - No current project available for OAuth connection');
      alert(t`No current project available. Please create a project first before connecting OAuth providers.`);
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
      console.error(`Failed to connect to ${connection.provider}:`, error);
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
      console.error(`Failed to disconnect from ${connection.provider}:`, error);
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
    <div className="flex h-full flex-col p-4">
      <div className="mb-4">
        <h2 className="text-xl font-semibold"><Trans>OAuth Connections</Trans></h2>
      </div>

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]"><Trans>Provider</Trans></TableHead>
              <TableHead className="w-[250px]"><Trans>Status</Trans></TableHead>
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
                  <TableCell className="w-[250px]">
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
