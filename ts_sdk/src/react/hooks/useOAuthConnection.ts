import {
  ConnectionStatus,
  EnvStatusEnum,
  EnvVarType,
  OAuthEventType,
  OAuthStatus,
  TypeId,
  dataContext,
  dataManager,
  oauthService,
  type EntityEnvVars,
  type EnvVarStatus,
  type OAuthDetachResult,
  type OAuthProvider,
  type OAuthTestResult,
} from '@sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { entityEnvQueryKey, useEntityEnv } from './useEntityEnv';

interface UseOAuthConnectionOptions {
  projectTypeId?: TypeId;
  onConnectionConnect?: (connectionId: string) => void; // For backward compatibility
  onConnectionDisconnect?: (connectionId: string, detachResult?: OAuthDetachResult) => void;
  // New specific callbacks for different operations
  onOAuthAuthSuccess?: (connectionId: string) => void; // OAuth auth completed (status: AVAILABLE)
  onAttachSuccess?: (connectionId: string) => void; // Attach completed (status: CONNECTED)
}

interface UseOAuthConnectionReturn {
  isConnecting: boolean;
  connectingConnectionId: string | null; // ID of the connection currently being processed
  currentOAuthFlow: { connectionId: string; provider: string } | null;
  availableProviders: OAuthProvider[];
  connectionStatuses: Record<string, ConnectionStatus>;
  connect: (connectionId: string, provider: string, sharedEntityVarName?: string) => Promise<void>;
  attach: (connectionId: string, provider: string, sharedEntityVarName?: string) => Promise<void>;
  detach: (connectionId: string, provider: string) => Promise<void>;
  /** Call the provider with the stored token — the only way to tell a live
   *  connection from one revoked at the provider. */
  testConnection: (provider: string) => Promise<OAuthTestResult>;
  disconnect: (connectionId: string, provider: string) => Promise<void>;
  delete: (connectionId: string, provider: string) => Promise<void>;
  getConnectionStatus: (provider: string) => Promise<ConnectionStatus>;
  getProviderName: (provider: string) => string;
}

/** One provider's connection status, from the two tables it is derived from. */
export function deriveConnectionStatus(
  providerName: string,
  userTable: EntityEnvVars,
  projectTable: EntityEnvVars,
): ConnectionStatus {
  const userProviderVar = userTable.values.find(
    (envVar: EnvVarStatus) => envVar.var_type === EnvVarType.OAUTH_PROVIDER_ID && envVar.name === providerName,
  );

  // No OAuth token exists at all — needs the full flow.
  if (!userProviderVar || !userProviderVar.ref_name) {
    return ConnectionStatus.DISCONNECTED;
  }

  // A credential the hub could not refresh is held but dead, and that outranks
  // everything below: "attached to this project" stays true and stops meaning
  // anything once the token behind it no longer works. Answering CONNECTED here
  // is how a row claims success while every call using it fails.
  if (userProviderVar.needs_reauth) {
    return ConnectionStatus.NEEDS_REAUTH;
  }

  // Match: project env var whose ref_name is the user's token name, ref_type USER.
  const projectEnvVar = projectTable.values.find(
    (envVar: EnvVarStatus) => envVar.ref_name === userProviderVar.ref_name && envVar.ref_type === ('user' as string),
  );

  // Not attached to this project — fall back to whether the user holds it at all.
  if (!projectEnvVar) {
    return userProviderVar.var_status === EnvStatusEnum.AVAILABLE
      ? ConnectionStatus.AVAILABLE
      : ConnectionStatus.DISCONNECTED;
  }

  if (projectEnvVar.var_status === EnvStatusEnum.AVAILABLE) return ConnectionStatus.CONNECTED;
  // Held, but this project has not been granted it yet — ready to attach.
  if (projectEnvVar.var_status === EnvStatusEnum.CONSENT_REQUIRED) return ConnectionStatus.AVAILABLE;
  return ConnectionStatus.DISCONNECTED;
}

export const useOAuthConnection = ({
  projectTypeId,
  onConnectionConnect,
  onConnectionDisconnect,
  onOAuthAuthSuccess,
  onAttachSuccess,
}: UseOAuthConnectionOptions): UseOAuthConnectionReturn => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectingConnectionId, setConnectingConnectionId] = useState<string | null>(null);
  const [currentOAuthFlow, setCurrentOAuthFlow] = useState<{ connectionId: string; provider: string } | null>(null);
  const queryClient = useQueryClient();

  // Use the unified hook to get user's env vars table data ONCE to determine available providers
  const userTypeId = dataContext.userTypeId;
  const { table: userTable } = useEntityEnv({
    entityTypeId: userTypeId || undefined,
  });

  // Use the unified hook to get project's env vars table data for status determination
  const { table: projectTable } = useEntityEnv({
    entityTypeId: projectTypeId || undefined,
    enabled: !!userTypeId,
  });

  // Extract available providers from USER table (once, doesn't change with project)
  const availableProviders = useMemo(() => {
    if (!userTable) return [];

    const providers: OAuthProvider[] = [];

    userTable.values
      .filter((envVar) => envVar.var_type === EnvVarType.OAUTH_PROVIDER_ID)
      .forEach((envVar) => {
        // Extract display_name from description: "OAuth integration for {DisplayName}"
        let displayName = envVar.name;
        if (envVar.description) {
          const match = envVar.description.match(/OAuth integration for (.+)/);
          if (match) {
            displayName = match[1];
          }
        }

        providers.push({
          name: envVar.name,
          display_name: displayName,
          // Icon is stored in icon field
          icon: envVar.icon || undefined,
          kind: (envVar.oauth_kind as OAuthProvider['kind']) || undefined,
          scopes: envVar.oauth_scopes?.length ? envVar.oauth_scopes : undefined,
        });
      });

    return providers;
  }, [userTable]);

  // Purely derived from the two tables, so it is computed, not stored. Holding it
  // in state meant an initializer and an effect that computed the same map — the
  // effect always setState'd a freshly-allocated object, so React could never
  // bail out and every table read re-rendered the whole connections table twice.
  // The initializer existed only to hide the blink that arrangement caused.
  const connectionStatuses = useMemo<Record<string, ConnectionStatus>>(() => {
    const ready = userTable && projectTable;
    return Object.fromEntries(
      availableProviders.map((provider) => [
        provider.name,
        ready ? deriveConnectionStatus(provider.name, userTable, projectTable) : ConnectionStatus.DISCONNECTED,
      ]),
    );
  }, [userTable, projectTable, availableProviders]);

  // Listen for OAuth flow completion (auth + attach) via custom event
  useEffect(() => {
    const handleOAuthFlowComplete = (data: { status: OAuthStatus; attachSuccess?: boolean }) => {
      if (data.status === OAuthStatus.SUCCESS && currentOAuthFlow) {
        // Store connection ID before clearing the flow
        const connectionId = currentOAuthFlow.connectionId;

        // Clear the current OAuth flow
        setCurrentOAuthFlow(null);
        setIsConnecting(false);
        setConnectingConnectionId(null);

        // Invalidate queries to get updated statuses
        void queryClient.invalidateQueries({
          queryKey: entityEnvQueryKey(projectTypeId),
        });

        // Call the appropriate callback based on the operation result
        if (data.attachSuccess === true) {
          onAttachSuccess?.(connectionId);
        } else if (data.attachSuccess === false) {
          onOAuthAuthSuccess?.(connectionId);
        } else {
          onConnectionConnect?.(connectionId);
        }
      } else if (data.status === OAuthStatus.ERROR && currentOAuthFlow) {
        console.error('[useOAuthConnection] OAuth error:', data);
        // Clear the current OAuth flow on error
        setCurrentOAuthFlow(null);
        setIsConnecting(false);
        setConnectingConnectionId(null);
      }
    };

    // Listen to dataManager OAuth flow complete events
    dataManager.on(OAuthEventType.OAUTH_FLOW_COMPLETE, handleOAuthFlowComplete);

    return () => {
      dataManager.off(OAuthEventType.OAUTH_FLOW_COMPLETE, handleOAuthFlowComplete);
    };
  }, [currentOAuthFlow, onConnectionConnect, onOAuthAuthSuccess, onAttachSuccess, queryClient, projectTypeId]);

  const getProviderName = useCallback(
    (provider: string): string => {
      const providerInfo = availableProviders.find((p) => p.name === provider);
      return providerInfo?.name || provider.toLowerCase();
    },
    [availableProviders],
  );

  const connect = useCallback(
    async (connectionId: string, provider: string, sharedEntityVarName?: string) => {
      try {
        setIsConnecting(true);
        setConnectingConnectionId(connectionId);

        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        // Set the current OAuth flow before starting
        setCurrentOAuthFlow({ connectionId, provider });

        // Use OAuth service to connect - this starts the OAuth flow
        await oauthService.connect(providerName, projectTypeId, sharedEntityVarName);

        // Note: Don't call onConnectionConnect here - it will be called when OAuth completes
      } catch (error) {
        console.error(`Failed to connect to ${provider}:`, error);
        // Clear the current OAuth flow on error
        setCurrentOAuthFlow(null);
        setIsConnecting(false);
        setConnectingConnectionId(null);
        throw error;
      }
    },
    [projectTypeId, getProviderName],
  );

  const testConnection = useCallback(
    async (provider: string) => oauthService.test(getProviderName(provider), projectTypeId),
    [projectTypeId, getProviderName],
  );

  const attach = useCallback(
    async (connectionId: string, provider: string, sharedEntityVarName?: string) => {
      try {
        setIsConnecting(true);
        setConnectingConnectionId(connectionId);

        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        if (!projectTypeId) {
          console.error('[useOAuthConnection] ERROR - No current project available for attach operation');
          throw new Error('No current project available for attach operation');
        }

        // Use OAuth service to attach current project to existing token
        await oauthService.attach(providerName, projectTypeId, sharedEntityVarName);

        // Invalidate queries to get updated statuses
        await queryClient.invalidateQueries({
          queryKey: entityEnvQueryKey(projectTypeId),
        });

        // Call the attach success callback (status: CONNECTED)
        onAttachSuccess?.(connectionId);
      } catch (error) {
        console.error(`Failed to attach ${provider}:`, error);
        throw error;
      } finally {
        setIsConnecting(false);
        setConnectingConnectionId(null);
      }
    },
    [projectTypeId, getProviderName, queryClient, onAttachSuccess],
  );

  const detach = useCallback(
    async (connectionId: string, provider: string) => {
      try {
        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        if (!projectTypeId) {
          throw new Error('No current project available for detach operation');
        }

        // Use OAuth service to detach current project
        const detachResult = await oauthService.detach(providerName, projectTypeId);

        // Invalidate queries to get updated statuses
        await queryClient.invalidateQueries({
          queryKey: entityEnvQueryKey(projectTypeId),
        });

        // If no more attachments remain, automatically disconnect to remove OAuth credentials
        if (detachResult && detachResult.remaining_attachment_count === 0) {
          try {
            // Call disconnect to remove OAuth credentials
            await oauthService.disconnect(providerName);
            // Invalidate both user and project queries after disconnect
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: entityEnvQueryKey(projectTypeId),
              }),
              queryClient.invalidateQueries({
                queryKey: entityEnvQueryKey(userTypeId),
              }),
            ]);

            // Update the detach result to indicate full disconnection
            const disconnectResult = {
              ...detachResult,
              remaining_attachment_count: 0,
              fully_disconnected: true,
            };

            onConnectionDisconnect?.(connectionId, disconnectResult);
          } catch (disconnectError) {
            console.error(`[useOAuthConnection] Failed to auto-disconnect ${provider}:`, disconnectError);
            // Still call the disconnect callback with original detach result
            onConnectionDisconnect?.(connectionId, detachResult);
          }
        } else {
          // Normal detach - still has other attachments
          onConnectionDisconnect?.(connectionId, detachResult);
        }
      } catch (error) {
        console.error(`Failed to detach ${provider}:`, error);
        throw error;
      }
    },
    [projectTypeId, getProviderName, onConnectionDisconnect, queryClient, userTypeId],
  );

  const disconnect = useCallback(
    async (connectionId: string, provider: string) => {
      try {
        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        // Use OAuth service to disconnect (remove OAuth token completely)
        const disconnectResult = await oauthService.disconnect(providerName);

        // Invalidate both user and project queries to get updated statuses
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: entityEnvQueryKey(projectTypeId),
          }),
          queryClient.invalidateQueries({
            queryKey: entityEnvQueryKey(userTypeId),
          }),
        ]);

        // Call the callback to update the connection status
        // Disconnect always results in 0 remaining attachments
        onConnectionDisconnect?.(connectionId, disconnectResult);
      } catch (error) {
        console.error(`Failed to disconnect ${provider}:`, error);
        throw error;
      }
    },
    [getProviderName, onConnectionDisconnect, queryClient, projectTypeId, userTypeId],
  );

  const deleteConnection = useCallback(
    async (connectionId: string, provider: string) => {
      try {
        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        if (!projectTypeId) {
          throw new Error('No current project available for delete operation');
        }

        // Use OAuth service to delete the connection entirely
        await oauthService.delete(providerName, projectTypeId);

        // Call the callback to update the connection status
        onConnectionDisconnect?.(connectionId);
      } catch (error) {
        console.error(`Failed to delete ${provider}:`, error);
        throw error;
      }
    },
    [projectTypeId, getProviderName, onConnectionDisconnect],
  );

  const getConnectionStatus = useCallback(
    async (provider: string) => {
      try {
        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        if (!projectTypeId) {
          console.warn('No current project available for getConnectionStatus operation');
          return ConnectionStatus.DISCONNECTED;
        }

        // Use OAuth service to get connection status
        return await oauthService.getConnectionStatus(providerName, projectTypeId);
      } catch (error) {
        console.error(`Failed to get connection status for ${provider}:`, error);
        // Return DISCONNECTED as fallback
        return ConnectionStatus.DISCONNECTED;
      }
    },
    [projectTypeId, getProviderName],
  );

  return {
    isConnecting,
    connectingConnectionId,
    currentOAuthFlow,
    availableProviders,
    connectionStatuses,
    connect,
    attach,
    detach,
    testConnection,
    disconnect,
    delete: deleteConnection,
    getConnectionStatus,
    getProviderName,
  };
};
