import { EventEmitter } from 'events';
import { ActionInfo, dataContext, dataManager, OAuthMessage, TypeId } from '../../index';
import { EntityEnv, EnvVarType } from '../../models/env_var';
import { connectionManager } from '../../websocket';
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
  /** Held but dead: the hub's refresh was permanently refused, so the row must
   *  offer Connect rather than claim success. Distinct from DISCONNECTED — we
   *  still hold a credential, it just no longer works. */
  NEEDS_REAUTH = 'NEEDS_REAUTH',
}

export enum OAuthStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}

export enum OAuthEventType {
  OAUTH_MSG = 'on_oauth_msg',
  WINDOW_CLOSE = 'on_window_close',
  OAUTH_FLOW_COMPLETE = 'on_oauth_flow_complete',
  /** A stored credential was dropped. Deliberately NOT a flow completion: no
   *  flow ran, so a pending Connect must not treat it as its own success. */
  OAUTH_DISCONNECTED = 'on_oauth_disconnected',
  /** Fired when an OAuth flow requires the user to enter a device code
   *  (RFC 8628). UI listens and renders a modal with `user_code` + verify URL. */
  DEVICE_FLOW_START = 'on_oauth_device_flow_start',
}

/**
 * Payload emitted by OAUTH_FLOW_COMPLETE — the ONE event a UI should listen to
 * for "an OAuth flow for provider X finished".
 *
 * It is deliberately runtime-agnostic. The desktop backend broadcasts
 * `llm_config_msg` on a completed grant and the hub broadcasts only
 * `oauth_msg`, so a component listening to either raw WS message works on one
 * runtime and silently does nothing on the other. Both paths converge here, as
 * does the device flow (RFC 8628) and `disconnect`.
 */
export interface OAuthFlowCompletePayload {
  provider: string;
  status: OAuthStatus;
  /** Correlates with the flow's state; always set for popup + device flows. */
  oauth_request_id?: string;
  targetEntity?: TypeId;
  /** true/false when an attach was attempted, null when it wasn't. */
  attachSuccess: boolean | null;
}

/** Payload emitted by OAUTH_DISCONNECTED. */
export interface OAuthDisconnectedPayload {
  provider: string;
}

/** Payload emitted by DEVICE_FLOW_START. */
export interface OAuthDeviceFlowPayload {
  provider: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  state: string;
}

export interface OAuthProvider {
  name: string;
  display_name: string;
  icon?: string;
  /** Which OAuth grant this provider's flow uses. */
  kind?: OAuthFlowKind;
  /** Scopes the flow will request; empty when the owning side does not publish them. */
  scopes?: string[];
}

/** The OAuth grants a provider's flow can use. Mirrors the backend's
 *  `OAuthFlowKind` — shown to the user because the three differ in what they
 *  ask of them and in what the resulting token can do. */
export type OAuthFlowKind = 'code' | 'loopback' | 'device';

/** What a connection test found. */
export interface OAuthTestResult {
  /** true = the provider accepted the token; false = it rejected it;
   *  null = not checked (no probe, or the provider could not be reached). */
  ok: boolean | null;
  /** Who the token belongs to, when the provider says. */
  identity?: string | null;
  detail?: string | null;
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

/** The backend's own message for a failed OAuth call.
 *
 * These paths fail for reasons the user can act on ("no token yet", "this
 * instance cannot complete a flow for that provider"), and all of that lives in
 * the `{status:'FAIL', message}` envelope. Re-throwing only Axios's
 * "Request failed with status code 500" throws that away, so the toast ends up
 * saying nothing at all. */
function oauthErrorText(error: unknown, fallback: string): string {
  const envelope = (error as { response?: { data?: { message?: string; detail?: string } } })?.response?.data;
  return envelope?.message || envelope?.detail || (error instanceof Error ? error.message : fallback);
}

/** Coerce a backend-supplied status string to the two-valued enum. Anything
 *  that isn't an explicit success is an error — a flow that didn't grant. */
function toOAuthStatus(raw: string | undefined): OAuthStatus {
  return raw === OAuthStatus.SUCCESS ? OAuthStatus.SUCCESS : OAuthStatus.ERROR;
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

  /** Typed wrapper so every emit site produces the same payload shape. */
  private emitFlowComplete(payload: OAuthFlowCompletePayload) {
    dataManager.emit(OAuthEventType.OAUTH_FLOW_COMPLETE, payload);
  }

  public async onOAuthMessage(data: OAuthMessage) {
    const oauthFlow = this.oAuthFlows.get(data.oauth_request_id);
    if (!oauthFlow) {
      // FlowpadCloud is owned by cloudManager — its WS messages don't go through this map.
      if (data.oauth_request_id !== OAUTH_PROVIDERS.FLOWPAD_CLOUD) {
        console.error(`[OAuthService] OAuth flow not found for request id:`, data.oauth_request_id);
        console.error(`[OAuthService] Available flows:`, Array.from(this.oAuthFlows.keys()));
      }
      return;
    }

    oauthFlow.closeWindow();
    this.oAuthFlows.delete(data.oauth_request_id);

    const provider = oauthFlow.oAuthRequestInfo.provider;
    const status = toOAuthStatus(data.status);

    // A grant with a target entity attaches before the flow counts as done.
    // `null` = no attach was attempted, which is not the same as one that failed.
    let attachSuccess: boolean | null = null;
    if (status === OAuthStatus.SUCCESS && oauthFlow.targetEntity) {
      try {
        await this.attach(provider, oauthFlow.targetEntity, oauthFlow.sharedEntityVarName);
        attachSuccess = true;
      } catch (error) {
        // The auth itself succeeded — only the attach didn't.
        console.error(`[OAuthService] Auto-attach failed for ${provider}:`, error);
        attachSuccess = false;
      }
    }

    // A denied/failed grant is reported too: consumers spin on "connecting"
    // until the flow says it ended, whichever way it ended.
    this.emitFlowComplete({
      provider,
      status,
      oauth_request_id: data.oauth_request_id,
      targetEntity: oauthFlow.targetEntity,
      attachSuccess,
    });
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

      // Probe the backend's `/auth` response directly so we can branch on the
      // discriminator without forcing a popup for device-flow providers.
      const actionInfo = new ActionInfo('oauth');
      if (targetEntity) actionInfo.targetEntity = targetEntity;
      actionInfo.subpath = [provider, 'auth'];
      if (sharedEntityVarName) {
        actionInfo.queryParameters = { shared_entity_var_name: sharedEntityVarName };
      }
      const raw = await dataManager.callAction<unknown, Record<string, unknown>>(actionInfo);
      if (!raw) {
        throw new Error(`Empty OAuth /auth response for ${provider}`);
      }

      // Device flow (e.g. GitHub): no browser popup; emit an event so the UI can
      // render a code-display modal. Then kick off the long-poll on wait-callback.
      if ((raw as { kind?: string }).kind === 'device') {
        const payload: OAuthDeviceFlowPayload = {
          provider,
          user_code: String(raw.user_code ?? ''),
          verification_uri: String(raw.verification_uri ?? ''),
          expires_in: Number(raw.expires_in ?? 900),
          interval: Number(raw.interval ?? 5),
          state: String(raw.state ?? ''),
        };
        // Attach the completion listener BEFORE emitting DEVICE_FLOW_START so a
        // race between a near-instant SUCCESS broadcast and the modal's own
        // listener can't drop the result. Listener also fires OAUTH_FLOW_COMPLETE
        // so useOAuthConnection.connect() can clear its `isConnecting` spinner.
        const completionHandler = (msg: { auth_method?: string; oauth_request_id?: string; status?: string }) => {
          if (msg.auth_method !== provider) return;
          if (msg.oauth_request_id && msg.oauth_request_id !== payload.state) return;
          connectionManager.off('on_llm_config_msg', completionHandler);
          this.emitFlowComplete({
            provider,
            status: toOAuthStatus(msg.status),
            oauth_request_id: msg.oauth_request_id ?? payload.state,
            targetEntity,
            attachSuccess: null,
          });
        };
        connectionManager.on('on_llm_config_msg', completionHandler);
        dataManager.emit(OAuthEventType.DEVICE_FLOW_START, payload);

        // Long-poll the wait-callback action; this resolves when GitHub authorizes
        // (or rejects / expires). The backend writes to SOD on success and
        // broadcasts an LlmConfigMessage that the listener above picks up. The
        // backend bounds this at OAUTH_CALLBACK_TIMEOUT and returns
        // `{status: "polling"}` if the user takes longer than that window —
        // polling continues server-side as a background task in that case.
        // Fire-and-forget — the modal + completionHandler own the UX via the broadcast.
        void this.waitCallback(provider, payload.state, targetEntity).catch((err) => {
          console.warn(`[OAuthService] device-flow wait-callback errored for ${provider}:`, err);
        });
        return null;
      }

      // Loopback flow (Anthropic et al.): adapt to OAuthClientRequestInfo + popup.
      const authUrl = String(raw.auth_url ?? raw.url ?? '');
      if (!authUrl) {
        throw new Error(`Invalid OAuth response for ${provider}: missing auth_url`);
      }
      const oauthRequestInfo: OAuthClientRequestInfo = {
        provider,
        auth_url: authUrl,
        oauth_request_id: String(raw.oauth_request_id ?? raw.state ?? ''),
      };
      const popupWindow = await this.createOAuthPopupWindow(oauthRequestInfo.auth_url, provider);
      if (!popupWindow) {
        console.error(`[OAuthService] Failed to create popup window`);
        throw new Error(`Failed to create popup window`);
      }
      const oauthFlow = new OauthFlow(oauthRequestInfo, popupWindow, targetEntity, sharedEntityVarName);
      this.oAuthFlows.set(oauthRequestInfo.oauth_request_id, oauthFlow);

      // A `code` grant looks like a `loopback` one from here — same popup, same
      // auth_url — but it does not finish like one: its redirect is handled by
      // the HUB, not by a port on this machine. So no local server posts a
      // result back, `onOAuthMessage` is never called, and the hub's completion
      // websocket is not one this process is on either. Treated as loopback,
      // the user authorized successfully and the app waited forever for a
      // message nobody would send: the token sat on the hub, the connection read
      // as MISSING, and the caller's spinner never stopped. `wait-callback` is
      // the backend's own answer — it polls the hub and adopts the token into
      // local SOD — so drive it.
      if ((raw as { kind?: OAuthFlowKind }).kind === 'code') {
        void this.driveHubCallback(provider, oauthRequestInfo, oauthFlow, targetEntity);
      }

      return oauthFlow;
    } catch (error) {
      console.error(`[OAuthService] OAuth connection failed for ${provider}:`, error);
      throw error;
    }
  }

  /**
   * The backend's `wait-callback` for one flow.
   *
   * Both grants that finish somewhere OTHER than this machine go through it —
   * the device grant so the backend polls the provider, the hub-redirected
   * `code` grant so it polls the hub — so the call is built once here rather
   * than twice, subtly differently. What the two do with the ANSWER still
   * differs, and that stays at the call sites: the device flow is told by a
   * broadcast and the backend keeps polling in the background, while a hub flow
   * has no background task and no broadcast that reaches here, so its caller
   * loops until the answer changes.
   */
  private waitCallback(
    provider: string,
    state: string,
    targetEntity?: TypeId,
  ): Promise<{ status?: string } | null> {
    const wait = new ActionInfo('oauth');
    if (targetEntity) wait.targetEntity = targetEntity;
    wait.subpath = [provider, 'wait-callback'];
    wait.method = 'POST';
    wait.queryParameters = { state };
    wait.bodyParameters = {};
    return dataManager.callAction<unknown, { status?: string }>(wait);
  }

  /**
   * Carry a hub-redirected (`code`) grant to completion, since nothing else will.
   *
   * `wait-callback` answers `success` once the hub holds the token (the backend
   * then copies it into local SOD), or `polling` when the user is still at the
   * provider. `polling` is the backend asking to be called again — it is the
   * protocol's own continuation, not a retry budget bolted on out here, and the
   * loop is bounded by the popup: close it and the flow is over. Emitting
   * OAUTH_FLOW_COMPLETE is what releases every caller's spinner, so it happens
   * on EVERY exit, including the one where the user walks away.
   */
  private async driveHubCallback(
    provider: string,
    info: OAuthClientRequestInfo,
    flow: OauthFlow,
    targetEntity?: TypeId,
  ): Promise<void> {
    const finish = (status: OAuthStatus) => {
      this.oAuthFlows.delete(info.oauth_request_id);
      this.emitFlowComplete({
        provider,
        status,
        oauth_request_id: info.oauth_request_id,
        targetEntity,
        attachSuccess: null,
      });
    };

    try {
      // `isClosed` reports whether the popup is OPEN (an inversion this class
      // already carries); read it through the flow so the two agree.
      for (;;) {
        const result = await this.waitCallback(provider, info.oauth_request_id, targetEntity);
        const status = String(result?.status ?? '');
        if (status === 'success') {
          finish(OAuthStatus.SUCCESS);
          return;
        }
        if (status !== 'polling') {
          console.warn(`[OAuthService] hub wait-callback for ${provider} answered ${status || 'nothing'}`);
          finish(OAuthStatus.FAILED);
          return;
        }
        if (!flow.isClosed) {
          // The popup is gone and the hub still has nothing: the user closed it
          // or gave up. Say so rather than leaving the caller waiting.
          finish(OAuthStatus.FAILED);
          return;
        }
      }
    } catch (err) {
      console.warn(`[OAuthService] hub wait-callback failed for ${provider}:`, err);
      finish(OAuthStatus.FAILED);
    }
  }

  /**
   * Ensure secret-keychain access is enabled. Returns false if the user cancels
   * or the OS denies — caller must NOT proceed to OAuth popup in that case.
   * Mirrors the gate inside navigationService.navigateToLogin so that any
   * cloud-login entry point (oauthService.connect) also provisions keychain
   * access before the OAuth popup opens.
   */
  private async ensureSecretsEnabled(): Promise<boolean> {
    try {
      const initial = await secretsService.isEnabled();
      if (initial?.enabled) return true;
    } catch {
      // probe failed (offline/server down) — fall through to provisioning
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

  /**
   * Signal the backend to terminate a running device-flow polling task.
   * Used by the device-flow modal's Cancel button so the backend doesn't keep
   * polling GitHub for the rest of the device-code's lifetime (~15 min).
   */
  public async cancelDeviceFlow(provider: string, state: string): Promise<void> {
    try {
      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'cancel'];
      actionInfo.method = 'POST';
      actionInfo.queryParameters = { state };
      actionInfo.bodyParameters = {};
      await dataManager.callAction<unknown, { cancelled: boolean }>(actionInfo);
    } catch (err) {
      // Cancellation is best-effort; if the backend is unreachable the session
      // will time out naturally at the device-code's natural expiry.
      console.warn(`[OAuthService] cancelDeviceFlow failed for ${provider}:`, err);
    }
  }

  /** Result of calling the provider with the stored token.
   *
   *  `ok` is three-valued: true/false are answers, null means the question was
   *  never asked (no probe for this provider, or the provider was unreachable) —
   *  which must not be shown as a pass. */
  public async test(provider: string, targetEntity?: TypeId): Promise<OAuthTestResult> {
    const actionInfo = new ActionInfo('oauth');
    if (targetEntity) actionInfo.targetEntity = targetEntity;
    actionInfo.subpath = [provider, 'test'];
    const raw = await dataManager.callAction<unknown, OAuthTestResult>(actionInfo);
    return raw ?? { ok: null, detail: 'No response from the connection test' };
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
      throw new Error(oauthErrorText(error, `Failed to attach ${provider} to entity`));
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
      throw new Error(oauthErrorText(error, `Failed to detach ${provider} from entity`));
    }
  }

  public async disconnect(provider: string): Promise<OAuthDetachResult> {
    try {
      // FlowpadCloud disconnect is owned by cloudManager.
      if (provider === OAUTH_PROVIDERS.FLOWPAD_CLOUD) {
        const { cloudManager } = await import('../cloud_login');
        await cloudManager.logout();
        dataManager.emit(OAuthEventType.OAUTH_DISCONNECTED, { provider } as OAuthDisconnectedPayload);
        return { remaining_attachment_count: 0 } as OAuthDetachResult;
      }

      const actionInfo = new ActionInfo('oauth');
      actionInfo.subpath = [provider, 'disconnect'];
      // No target entity needed for disconnect - it removes the user's token completely

      const response = await dataManager.callAction<unknown, OAuthDetachResult>(actionInfo);

      if (response?.browser_url) {
        await this.createOAuthPopupWindow(response.browser_url, provider);
      }

      dataManager.emit(OAuthEventType.OAUTH_DISCONNECTED, { provider } as OAuthDisconnectedPayload);

      return response;
    } catch (error) {
      console.error(`[OAuthService] OAuth disconnect failed for ${provider}:`, error);
      throw new Error(`Failed to disconnect ${provider}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
