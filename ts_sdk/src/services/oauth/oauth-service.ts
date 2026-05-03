import { EventEmitter } from 'events';
import { ActionInfo, dataContext, dataManager, OAuthMessage, TypeId } from '../../index';
import { EntityEnv, EnvVarType } from '../../models/env_var';
import { secretApprovalGate } from '../secretApprovalGate';
import { secretsService } from '../secrets-service';
import { BrowserAuthWindow, MockAuthWindow, OAuthWindow } from './oauth-window';

// OAuth Provider Constants
export const OAUTH_PROVIDERS = {
  GITHUB: 'github',
  SLACK: 'slack',
  FLOWPAD_CLOUD: 'flowpad_cloud',
} as const;

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  AVAILABLE = 'AVAILABLE',
  CONNECTED = 'CONNECTED',
}

export enum OAuthStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}

export enum OAuthEventType {
  OAUTH_MSG = 'on_oauth_msg',
  WINDOW_CLOSE = 'on_window_close',
  OAUTH_FLOW_COMPLETE = 'on_oauth_flow_complete',
}

export interface OAuthProvider {
  name: string;
  display_name: string;
  icon?: string;
}

export interface OAuthConnection {
  id: string;
  provider: string;
  status: ConnectionStatus;
  connectedAt?: Date;
  description?: string;
  hasTokenForOtherProjects?: boolean;
  attachedToCurrentProject?: boolean;
}

export interface OAuthDetachResult {
  remaining_attachment_count: number;
  browser_url?: string;
}

export interface OAuthClientRequestInfo {
  provider: string;
  auth_url: string;
  oauth_request_id: string;
}

export interface OAuthCallbackResponse {
  installed_plugins: any[];
}

export class OauthFlow extends EventEmitter {
  public readonly oAuthRequestInfo: OAuthClientRequestInfo;
  public readonly authWindow: OAuthWindow | null = null;
  public readonly startTime: Date;
  public readonly targetEntity?: TypeId;
  public readonly sharedEntityVarName?: string;

  constructor(
    oAuthRequestInfo: OAuthClientRequestInfo,
    authWindow: OAuthWindow,
    targetEntity?: TypeId,
    sharedEntityVarName?: string,
  ) {
    super();
    this.oAuthRequestInfo = oAuthRequestInfo;
    this.startTime = new Date();
    this.authWindow = authWindow;
    this.targetEntity = targetEntity;
    this.sharedEntityVarName = sharedEntityVarName;
  }

  get duration(): number {
    return (Date.now() - this.startTime.getTime()) / 1000;
  }

  get isClosed(): boolean {
    if (this.authWindow) {
      return this.authWindow.isOpen;
    } else {
      console.error(`[OAuthFlow] Window not found for OAuth request: ${this.oAuthRequestInfo.oauth_request_id}`);
      return false;
    }
  }

  public closeWindow(): void {
    if (this.authWindow) {
      this.authWindow.close();
      this.emit(OAuthEventType.WINDOW_CLOSE);
    } else {
      console.error(`[OAuthFlow] Window not found for OAuth request: ${this.oAuthRequestInfo.oauth_request_id}`);
    }
  }
}

export class OAuthService {
  private static instance: OAuthService;
  private oAuthFlows: Map<string, OauthFlow> = new Map();

  public async onOAuthMessage(data: OAuthMessage) {
    const oauthFlow = this.oAuthFlows.get(data.oauth_request_id);
    if (oauthFlow) {
      oauthFlow.closeWindow();

      // If OAuth authentication succeeded and we have a target entity, automatically attach
      if (data.status === OAuthStatus.SUCCESS && oauthFlow.targetEntity) {
        try {
          await this.attach(oauthFlow.oAuthRequestInfo.provider, oauthFlow.targetEntity, oauthFlow.sharedEntityVarName);

          // Emit custom event to notify that the complete OAuth flow (auth + attach) is done
          dataManager.emit(OAuthEventType.OAUTH_FLOW_COMPLETE, {
            ...data,
            provider: oauthFlow.oAuthRequestInfo.provider,
            targetEntity: oauthFlow.targetEntity,
            attachSuccess: true,
          });
        } catch (error) {
          console.error(`[OAuthService] Auto-attach failed for ${oauthFlow.oAuthRequestInfo.provider}:`, error);

          // Emit event even if attach failed - OAuth auth was successful
          dataManager.emit(OAuthEventType.OAUTH_FLOW_COMPLETE, {
            ...data,
            provider: oauthFlow.oAuthRequestInfo.provider,
            targetEntity: oauthFlow.targetEntity,
            attachSuccess: false,
            attachError: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      } else if (data.status === OAuthStatus.SUCCESS && !oauthFlow.targetEntity) {
        // Emit event for auth-only success (no attach needed)
        dataManager.emit(OAuthEventType.OAUTH_FLOW_COMPLETE, {
          ...data,
          provider: oauthFlow.oAuthRequestInfo.provider,
          targetEntity: undefined,
          attachSuccess: null, // No attach attempted
        });
      }

      // Clean up the OAuth flow
      this.oAuthFlows.delete(data.oauth_request_id);
    } else if (data.oauth_request_id !== OAUTH_PROVIDERS.FLOWPAD_CLOUD) {
      // FlowpadCloud is owned by cloudManager — its WS messages don't go through this map.
      console.error(`[OAuthService] OAuth flow not found for request id:`, data.oauth_request_id);
      console.error(`[OAuthService] Available flows:`, Array.from(this.oAuthFlows.keys()));
    }
  }

  private constructor() {
    dataManager.on(OAuthEventType.OAUTH_MSG, this.onOAuthMessage.bind(this));
  }

  public static getInstance(): OAuthService {
    if (!OAuthService.instance) {
      OAuthService.instance = new OAuthService();
    }
    return OAuthService.instance;
  }

  public async generateOauthRequestInfo(
    provider: string,
    targetEntity?: TypeId,
    sharedEntityVarName?: string,
  ): Promise<OAuthClientRequestInfo> {
    // Return mock OAuth request info for test providers
    if (provider === 'test_oauth' || provider === 'test_provider') {
      return {
        provider: provider,
        auth_url: 'https://mock-oauth-provider.com/auth',
        oauth_request_id: `test-oauth-request-${Date.now()}`,
      };
    }

    try {
      const actionInfo = new ActionInfo('oauth');

      // Set target entity if provided - this will be part of the path
      if (targetEntity) {
        actionInfo.targetEntity = targetEntity;
      }

      actionInfo.subpath = [provider, 'auth'];
      if (sharedEntityVarName) {
        actionInfo.queryParameters = {
          shared_entity_var_name: sharedEntityVarName,
        };
      }

      const response = await dataManager.callAction<unknown, OAuthClientRequestInfo>(actionInfo);

      if (!response || !response.auth_url) {
        console.error(`[OAuthService] Invalid OAuth response for ${provider}: missing auth_url`);
        throw new Error(`Invalid OAuth response for ${provider}: missing auth_url`);
      }

      return response;
    } catch (error) {
      console.error(`[OAuthService] Error starting OAuth flow for ${provider}:`, error);
      throw new Error(
        `Failed to start OAuth flow for ${provider}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  public async createOAuthPopupWindow(authUrl: string, provider: string): Promise<OAuthWindow | null> {
    // Return mock window object for test providers
    if (provider === 'test_oauth' || provider === 'test_provider') {
      const mockWindow = new MockAuthWindow();
      mockWindow.open(authUrl);
      return new Promise((resolve) => {
        setTimeout(() => resolve(mockWindow), 50);
      });
    }
    const browserWindow = new BrowserAuthWindow();
    browserWindow.open(authUrl);
    return browserWindow;
  }

  public async connect(
    provider: string,
    targetEntity?: TypeId,
    sharedEntityVarName?: string,
  ): Promise<OauthFlow | null> {
    try {
      // FlowpadCloud is owned by cloudManager — route there instead of going through
      // the generic OAuth popup machinery used by Slack/GitHub/etc.
      if (provider === OAUTH_PROVIDERS.FLOWPAD_CLOUD) {
        const { cloudManager } = await import('../cloud_login');
        await cloudManager.login();
        return null;
      }
      // Start OAuth flow
      const oauthRequestInfo = await this.generateOauthRequestInfo(provider, targetEntity, sharedEntityVarName);

      // Create popup window
      const popupWindow = await this.createOAuthPopupWindow(oauthRequestInfo.auth_url, provider);
      if (!popupWindow) {
        console.error(`[OAuthService] Failed to create popup window`);
        throw new Error(`Failed to create popup window`);
      }
      // Create and store OauthFlow instance
      const oauthFlow = new OauthFlow(oauthRequestInfo, popupWindow, targetEntity, sharedEntityVarName);
      this.oAuthFlows.set(oauthRequestInfo.oauth_request_id, oauthFlow);

      return oauthFlow;
    } catch (error) {
      console.error(`[OAuthService] OAuth connection failed for ${provider}:`, error);
      throw error;
    }
  }

  /**
   * Ensure secret-keychain access is enabled. Returns false if the user cancels
   * or the OS denies — caller must NOT proceed to OAuth popup in that case.
   * Mirrors the gate inside navigationService.navigateToLogin so that any
   * cloud-login entry point (oauthService.connect) also goes through the
   * SecretApprovalDialog before the OAuth popup opens.
   */
  private async ensureSecretsEnabled(): Promise<boolean> {
    try {
      const initial = await secretsService.isEnabled();
      if (initial?.enabled) return true;
    } catch {
      // probe failed (offline/server down) — fall through to the dialog
    }
    const approved = await secretApprovalGate.request();
    if (!approved) return false;
    try {
      const verified = await secretsService.isEnabled();
      return Boolean(verified?.enabled);
    } catch {
      return false;
    }
  }

  public async attach(provider: string, targetEntity: TypeId, sharedEntityVarName?: string): Promise<void> {
    try {
      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'attach'];
      actionInfo.targetEntity = targetEntity;

      if (sharedEntityVarName) {
        actionInfo.queryParameters = {
          shared_entity_var_name: sharedEntityVarName,
        };
      }

      await dataManager.callAction<unknown, void>(actionInfo);
    } catch (error) {
      console.error(`[OAuthService] OAuth attach failed for ${provider}:`, error);
      throw new Error(
        `Failed to attach ${provider} to entity: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  public async detach(provider: string, targetEntity: TypeId): Promise<OAuthDetachResult> {
    try {
      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'detach'];
      actionInfo.targetEntity = targetEntity;

      const response = await dataManager.callAction<unknown, OAuthDetachResult>(actionInfo);

      return response;
    } catch (error) {
      console.error(`[OAuthService] OAuth detach failed for ${provider}:`, error);
      throw new Error(
        `Failed to detach ${provider} from entity: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  public async disconnect(provider: string): Promise<OAuthDetachResult> {
    try {
      // FlowpadCloud disconnect is owned by cloudManager.
      if (provider === OAUTH_PROVIDERS.FLOWPAD_CLOUD) {
        const { cloudManager } = await import('../cloud_login');
        await cloudManager.logout();
        dataManager.emit(OAuthEventType.OAUTH_FLOW_COMPLETE, {
          provider,
          disconnectSuccess: true,
        });
        return { remaining_attachment_count: 0 } as OAuthDetachResult;
      }

      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'disconnect'];
      // No target entity needed for disconnect - it removes the user's token completely

      const response = await dataManager.callAction<unknown, OAuthDetachResult>(actionInfo);

      if (response?.browser_url) {
        await this.createOAuthPopupWindow(response.browser_url, provider);
      }

      dataManager.emit(OAuthEventType.OAUTH_FLOW_COMPLETE, {
        provider,
        disconnectSuccess: true,
      });

      return response;
    } catch (error) {
      console.error(`[OAuthService] OAuth disconnect failed for ${provider}:`, error);
      throw new Error(`Failed to disconnect ${provider}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async delete(provider: string, targetEntity: TypeId): Promise<void> {
    try {
      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'disconnect'];
      actionInfo.targetEntity = targetEntity;

      await dataManager.callAction<unknown, void>(actionInfo);
    } catch (error) {
      console.error(`[OAuthService] OAuth delete failed for ${provider}:`, error);
      throw new Error(
        `Failed to delete ${provider} from entity: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  public async getConnectionStatus(provider: string, targetEntity: TypeId): Promise<ConnectionStatus> {
    try {
      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'status'];
      actionInfo.targetEntity = targetEntity;

      interface StatusResponse {
        status: string;
        has_token: boolean;
        is_attached: boolean;
      }

      const response = await dataManager.callAction<unknown, StatusResponse>(actionInfo);

      // Convert backend status string to ConnectionStatus enum
      switch (response.status) {
        case 'connected':
          return ConnectionStatus.CONNECTED;
        case 'connected_other_projects':
          return ConnectionStatus.AVAILABLE;
        case 'not_connected':
        default:
          return ConnectionStatus.DISCONNECTED;
      }
    } catch (error) {
      console.error(`[OAuthService] Error checking connection status for ${provider}:`, error);
      return ConnectionStatus.DISCONNECTED;
    }
  }

  /**
   * Get available OAuth providers
   * @returns Promise<OAuthProvider[]> - List of available providers
   */
  public async getAvailableProviders(): Promise<OAuthProvider[]> {
    // Get current user's TypeId
    const userTypeId = dataContext.userTypeId;
    if (!userTypeId) {
      console.error('[OAuthService] No user TypeId available to fetch OAuth providers');
      return [];
    }

    const entityEnv = new EntityEnv(userTypeId);
    const response = await entityEnv.getTable();

    // Transform EntityEnvVars to OAuthProvider[]
    const providers: OAuthProvider[] = response.values
      .filter((envVar) => envVar.var_type === EnvVarType.OAUTH_PROVIDER_ID)
      .map((envVar) => {
        // Extract display_name from description: "OAuth integration for {DisplayName}"
        let displayName = envVar.name;
        if (envVar.description) {
          const match = envVar.description.match(/OAuth integration for (.+)/);
          if (match) {
            displayName = match[1];
          }
        }

        return {
          name: envVar.name,
          display_name: displayName,
          // Icon is stored in visible_value field
          icon: envVar.visible_value || undefined,
        };
      });

    return providers;
  }
}

// Export singleton instance
export const oauthService = OAuthService.getInstance();
