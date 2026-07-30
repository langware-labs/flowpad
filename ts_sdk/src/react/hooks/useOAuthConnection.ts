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

  // State to store connection statuses (will be updated asynchronously)
  const [connectionStatuses, setConnectionStatuses] = useState<Record<string, ConnectionStatus>>(() => {
    // Initialize with cached data to prevent blinking
    if (!userTable || !projectTable || !availableProviders.length) {
      return {};
    }

    const statuses: Record<string, ConnectionStatus> = {};

    // Process each provider using cached data
    for (const provider of availableProviders) {
      // Find the user's OAuth token name for this provider
      const userProviderVar = userTable.values.find(
        (envVar: EnvVarStatus) => envVar.var_type === EnvVarType.OAUTH_PROVIDER_ID && envVar.name === provider.name,
      );

      if (!userProviderVar || !userProviderVar.ref_name) {
        // No OAuth token exists at all - need full OAuth flow
        statuses[provider.name] = ConnectionStatus.DISCONNECTED;
        continue;
      }

      // Look for matching env var in project table
      const projectEnvVar = projectTable.values.find(
        (envVar: EnvVarStatus) =>
          envVar.ref_name === userProviderVar.ref_name && envVar.ref_type === ('user' as string),
      );

      if (!projectEnvVar) {
        // No project env var - check user's OAuth token status directly
        const userTokenStatus = userProviderVar.var_status;
        if (userTokenStatus === EnvStatusEnum.AVAILABLE) {
          statuses[provider.name] = ConnectionStatus.AVAILABLE;
        } else {
          statuses[provider.name] = ConnectionStatus.DISCONNECTED;
        }
      } else {
        // Found matching project env var, check its status
        const projectVarStatus = projectEnvVar.var_status;
        if (projectVarStatus === EnvStatusEnum.AVAILABLE) {
          statuses[provider.name] = ConnectionStatus.CONNECTED;
        } else if (projectVarStatus === EnvStatusEnum.CONSENT_REQUIRED) {
          statuses[provider.name] = ConnectionStatus.AVAILABLE;
        } else {
          statuses[provider.name] = ConnectionStatus.DISCONNECTED;
        }
      }
    }

    return statuses;
  });

  // Effect to determine connection statuses by matching providers to project env vars
  useEffect(() => {
    const determineStatuses = () => {
      if (!userTable || !projectTable || !availableProviders.length) {
        // Default all providers to DISCONNECTED if no project table
        const statuses: Record<string, ConnectionStatus> = {};
        availableProviders.forEach((provider) => {
          statuses[provider.name] = ConnectionStatus.DISCONNECTED;
        });
        setConnectionStatuses(statuses);
        return;
      }

      const statuses: Record<string, ConnectionStatus> = {};

      // Process each provider
      for (const provider of availableProviders) {
        // Find the user's OAuth token name for this provider
        const userProviderVar = userTable.values.find(
          (envVar: EnvVarStatus) => envVar.var_type === EnvVarType.OAUTH_PROVIDER_ID && envVar.name === provider.name,
        );

        if (!userProviderVar || !userProviderVar.ref_name) {
          // No OAuth token exists at all - need full OAuth flow
          statuses[provider.name] = ConnectionStatus.DISCONNECTED;
          continue;
        }

        // Look for matching env var in project table
        // Match: project env var where ref_name matches user's OAuth token name AND ref_type is USER
        const projectEnvVar = projectTable.values.find(
          (envVar: EnvVarStatus) =>
            envVar.ref_name === userProviderVar.ref_name && envVar.ref_type === ('user' as string), // BuiltinEntityType.USER
        );

        if (!projectEnvVar) {
          // No project env var - check user's OAuth token status directly
          const userTokenStatus = userProviderVar.var_status;
          if (userTokenStatus === EnvStatusEnum.AVAILABLE) {
            // OAuth token exists and is available but not attached to this project - ready to attach
            statuses[provider.name] = ConnectionStatus.AVAILABLE;
          } else {
            // User's OAuth token is not available (expired, revoked, missing, etc.)
            statuses[provider.name] = ConnectionStatus.DISCONNECTED;
          }
        } else {
          // Found matching project env var, check its status
          // Project env var status already reflects the user token validity
          const projectVarStatus = projectEnvVar.var_status;
          if (projectVarStatus === EnvStatusEnum.AVAILABLE) {
            // Token is attached and available
            statuses[provider.name] = ConnectionStatus.CONNECTED;
          } else if (projectVarStatus === EnvStatusEnum.CONSENT_REQUIRED) {
            // Token exists but needs consent (ready to attach)
            statuses[provider.name] = ConnectionStatus.AVAILABLE;
          } else {
            // MISSING or other status
            statuses[provider.name] = ConnectionStatus.DISCONNECTED;
          }
        }
      }

      setConnectionStatuses(statuses);
    };

    void determineStatuses();
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
