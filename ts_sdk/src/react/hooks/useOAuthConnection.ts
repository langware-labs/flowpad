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
  oauthProviderDisplayName,
  type EntityEnvVars,
  type EnvVarStatus,
  type OAuthDetachResult,
  type OAuthFlowCompletePayload,
  type OAuthProvider,
  type OAuthTestResult,
} from '@sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { iconAssetUrl, isIconPath } from '../../utils/icon-asset';
import { entityEnvQueryKey, entityEnvQueryKeyRoot, useEntityEnv } from './useEntityEnv';

interface UseOAuthConnectionOptions {
  projectTypeId?: TypeId;
  onConnectionConnect?: (connectionId: string) => void; // For backward compatibility
  onConnectionDisconnect?: (connectionId: string, detachResult?: OAuthDetachResult) => void;
  // New specific callbacks for different operations
  onOAuthAuthSuccess?: (connectionId: string) => void; // OAuth auth completed (status: AVAILABLE)
  onAttachSuccess?: (connectionId: string) => void; // Attach completed (status: CONNECTED)
}

interface UseOAuthConnectionReturn {
  connectingConnectionId: string | null; // ID of the connection currently being processed
  currentOAuthFlow: { connectionId: string; provider: string } | null;
  /** The user's env table, already fetched here to derive providers and grants.
   *  Returned so callers that need the same rows (the usage fan-out) share this
   *  observer instead of opening a second one on the identical query key. */
  userTable: EntityEnvVars | undefined;
  availableProviders: OAuthProvider[];
  /** Per-(user, project) status — what the SELECTED project sees. Drives the
   *  Status column; `CONNECTED` means "attached to that project". */
  connectionStatuses: Record<string, ConnectionStatus>;
  /** Per-user status — does the user hold a usable credential AT ALL, ignoring
   *  every project. A grant and a placement are different things (see
   *  `deriveGrantStatus`), and only this one is answerable with no project
   *  selected. Decides which actions a row offers. */
  grantStatuses: Record<string, GrantStatus>;
  connect: (connectionId: string, provider: string, sharedEntityVarName?: string) => Promise<void>;
  /** `targetEntity` defaults to the hook's project. Pass it to attach a project
   *  that is NOT the selected one — the usage popover grants access without
   *  making the user switch projects first. */
  attach: (
    connectionId: string,
    provider: string,
    sharedEntityVarName?: string,
    targetEntity?: TypeId,
  ) => Promise<void>;
  detach: (connectionId: string, provider: string, targetEntity?: TypeId) => Promise<void>;
  /** Call the provider with the stored token — the only way to tell a live
   *  connection from one revoked at the provider. */
  testConnection: (provider: string) => Promise<OAuthTestResult>;
  disconnect: (connectionId: string, provider: string) => Promise<void>;
  getConnectionStatus: (provider: string) => Promise<ConnectionStatus>;
  getProviderName: (provider: string) => string;
}

/**
 * A provider's icon, as something the browser can actually load.
 *
 * The one provider-specific bit on top of `iconAssetUrl`: a hub plugin manifest
 * states its icon RELATIVE TO THE PLUGIN FOLDER ("public/github-icon.svg"), and
 * the hub serves those at `/plugins/<provider>/<manifest path>`.
 */
export function providerIconUrl(providerName: string, icon?: string | null): string | undefined {
  if (!icon) return undefined;
  // A bare word is a lucide export name, not a file — passed through for
  // `lucideByName` downstream.
  if (!isIconPath(icon)) return icon;
  return iconAssetUrl(icon, `plugins/${providerName}`);
}

/** Stable empty table — also a fresh `{values: []}` per render would break the
 *  status memo. */
const EMPTY_ENV_TABLE: EntityEnvVars = { values: [] };

/**
 * Whether the USER holds a credential for a provider, independent of any
 * project. Three states, not four: attachment is not part of this question.
 */
export enum GrantStatus {
  /** No token at all — the row needs the full OAuth flow. */
  NONE = 'none',
  /** Held and usable. */
  HELD = 'held',
  /** Held but dead — the grant has to be made again. */
  NEEDS_REAUTH = 'needs_reauth',
}

/** A provider's grant state, from the user's table alone.
 *
 *  Deliberately a MAPPING over `deriveConnectionStatus` rather than a second
 *  walk of the same rows: against an empty project table that function already
 *  answers exactly this question (`CONNECTED` is unreachable with no
 *  placements), so the credential hierarchy — no token, dead token, usable
 *  token — is stated once. A second implementation would drift the moment a
 *  new state is added to it. */
export function deriveGrantStatus(providerName: string, userTable: EntityEnvVars): GrantStatus {
  switch (deriveConnectionStatus(providerName, userTable, EMPTY_ENV_TABLE)) {
    case ConnectionStatus.NEEDS_REAUTH:
      return GrantStatus.NEEDS_REAUTH;
    case ConnectionStatus.AVAILABLE:
    case ConnectionStatus.CONNECTED:
      return GrantStatus.HELD;
    default:
      return GrantStatus.NONE;
  }
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
        providers.push({
          name: envVar.name,
          display_name: oauthProviderDisplayName(envVar),
          icon: providerIconUrl(envVar.name, envVar.icon),
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
    // Only the USER table gates readiness. This used to require the project
    // table too, so with no project selected (the hub, where a user may hold
    // zero projects) every row rendered "Not connected" — the table claimed the
    // user held nothing while their credentials sat right there. An absent
    // project is not an unknown project: it is a project that attaches nothing,
    // which is exactly what an empty table means to `deriveConnectionStatus`.
    if (!userTable) {
      return Object.fromEntries(availableProviders.map((provider) => [provider.name, ConnectionStatus.DISCONNECTED]));
    }
    const table = projectTable ?? EMPTY_ENV_TABLE;
    return Object.fromEntries(
      availableProviders.map((provider) => [provider.name, deriveConnectionStatus(provider.name, userTable, table)]),
    );
  }, [userTable, projectTable, availableProviders]);

  const grantStatuses = useMemo<Record<string, GrantStatus>>(
    () =>
      Object.fromEntries(
        availableProviders.map((provider) => [
          provider.name,
          userTable ? deriveGrantStatus(provider.name, userTable) : GrantStatus.NONE,
        ]),
      ),
    [userTable, availableProviders],
  );

  // Listen for OAuth flow completion (auth + attach) via custom event
  useEffect(() => {
    const handleOAuthFlowComplete = (data: OAuthFlowCompletePayload) => {
      if (data.status === OAuthStatus.SUCCESS && currentOAuthFlow) {
        // Store connection ID before clearing the flow
        const connectionId = currentOAuthFlow.connectionId;

        // Clear the current OAuth flow
        setCurrentOAuthFlow(null);
        setConnectingConnectionId(null);

        // The grant lands on the USER's table, which every status here is
        // derived from — invalidating only the project key left it cached, so a
        // provider read "Not connected" until a reload, and with no project
        // selected the key holds nothing at all and the refresh was a no-op.
        void queryClient.invalidateQueries({ queryKey: entityEnvQueryKeyRoot });

        // Call the appropriate callback based on the operation result
        if (data.attachSuccess === true) {
          onAttachSuccess?.(connectionId);
        } else if (data.attachSuccess === false) {
          onOAuthAuthSuccess?.(connectionId);
        } else {
          onConnectionConnect?.(connectionId);
        }
      } else if (data.status !== OAuthStatus.SUCCESS && currentOAuthFlow) {
        if (data.status === OAuthStatus.ERROR) console.error('[useOAuthConnection] OAuth error:', data);
        // Denial, failure and correlated cancellation all terminate the flow.
        setCurrentOAuthFlow(null);
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
    async (connectionId: string, provider: string, sharedEntityVarName?: string, targetEntity?: TypeId) => {
      // The caller may name the project (the usage popover attaches one that is
      // not the selected one); otherwise it is the hook's project.
      const target = targetEntity ?? projectTypeId;
      try {
        setConnectingConnectionId(connectionId);

        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        if (!target) {
          console.error('[useOAuthConnection] ERROR - No target project for attach operation');
          throw new Error('No project available for attach operation');
        }

        // Use OAuth service to attach the target project to the existing token
        await oauthService.attach(providerName, target, sharedEntityVarName);

        // Invalidate the table that actually changed — not the selected
        // project's, which may be a different one entirely.
        await queryClient.invalidateQueries({
          queryKey: entityEnvQueryKey(target),
        });

        // Call the attach success callback (status: CONNECTED)
        onAttachSuccess?.(connectionId);
      } catch (error) {
        console.error(`Failed to attach ${provider}:`, error);
        throw error;
      } finally {
        setConnectingConnectionId(null);
      }
    },
    [projectTypeId, getProviderName, queryClient, onAttachSuccess],
  );

  const detach = useCallback(
    async (connectionId: string, provider: string, targetEntity?: TypeId) => {
      const target = targetEntity ?? projectTypeId;
      try {
        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        if (!target) {
          throw new Error('No project available for detach operation');
        }

        // Use OAuth service to detach the target project
        const detachResult = await oauthService.detach(providerName, target);

        // Invalidate queries to get updated statuses
        await queryClient.invalidateQueries({
          queryKey: entityEnvQueryKey(target),
        });

        // Detaching the LAST project does not destroy the credential. This used
        // to chain into `oauthService.disconnect()` whenever
        // `remaining_attachment_count` hit 0 — silently escalating "stop using
        // this here" into "revoke my token", which both backends explicitly
        // refuse to do on their own (flow_sdk oauth_attachment.detach_action,
        // hub likewise: "not auto-disconnecting. Use disconnect action"). The
        // client was overriding the server's invariant. Deleting a credential is
        // now its own confirmed act; the count is reported so callers can say so.
        onConnectionDisconnect?.(connectionId, detachResult);
      } catch (error) {
        console.error(`Failed to detach ${provider}:`, error);
        throw error;
      }
    },
    [projectTypeId, getProviderName, onConnectionDisconnect, queryClient],
  );

  const disconnect = useCallback(
    async (connectionId: string, provider: string) => {
      try {
        // Find the provider in available providers to get the correct name
        const providerName = getProviderName(provider);

        // Use OAuth service to disconnect (remove OAuth token completely)
        const disconnectResult = await oauthService.disconnect(providerName);

        // Every project that borrowed this credential now resolves differently,
        // and the caller does not know which those are — invalidate the whole
        // env-table family by prefix rather than the two keys we happen to hold.
        await queryClient.invalidateQueries({ queryKey: entityEnvQueryKeyRoot });

        // Call the callback to update the connection status
        // Disconnect always results in 0 remaining attachments
        onConnectionDisconnect?.(connectionId, disconnectResult);
      } catch (error) {
        console.error(`Failed to disconnect ${provider}:`, error);
        throw error;
      }
    },
    [getProviderName, onConnectionDisconnect, queryClient],
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
    connectingConnectionId,
    userTable,
    currentOAuthFlow,
    availableProviders,
    connectionStatuses,
    grantStatuses,
    connect,
    attach,
    detach,
    testConnection,
    disconnect,
    getConnectionStatus,
    getProviderName,
  };
};
