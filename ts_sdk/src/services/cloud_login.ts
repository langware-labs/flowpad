import { lazyAssets, LazyAsset } from '../lazy';
/**
 * Cloud login — single owner of cloud auth on the SDK side.
 *
 * Two orthogonal slots:
 *   _login      — LoginSlot<HubLoginStatus>      (logged_out / logging_in / logged_in / login_failed)
 *   _connection — ConnectionSlot<HubConnectionStatus>
 *                (disconnected / connecting / connected / verified / auth_rejected / error)
 *
 * They never mutate each other. A WS-layer rejection (the 403 surface)
 * flips _connection to 'auth_rejected' but leaves _login on 'logged_in'.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import { sdkConfig } from '../config/index';
import { API_PREFIX } from '../config/SDKConfig';
import { isHubOnly } from '../utils/hub-runtime';
import { User } from '../entities/user';
import { createCloudLoginFailedWarning } from '../models/UserWarning';
import { resolveLoginCallbackUrl } from './login_callback';
import type { CloudConnectionStatusMessage, CloudLoginStatusMessage, OAuthMessage } from '../websocket';
import { OAUTH_PROVIDERS } from './oauth/oauth-service';
import { privacyManager } from './privacy_mode';
import { secretApprovalGate } from './secretApprovalGate';
import { secretsService } from './secrets-service';
import {
  ConnectionSlot,
  HubConnectionStatus,
  HubLoginStatus,
  LocalConnectionStatus,
  LoginSlot,
  isHubConnected,
  makeConnectionSlot,
  makeLoginSlot,
} from './cloud_status';

type DataManagerRef = (typeof import('../APIEntity'))['dataManager'];
let _dataManagerCache: DataManagerRef | null = null;
async function _dataManager(): Promise<DataManagerRef> {
  if (!_dataManagerCache) _dataManagerCache = (await import('../APIEntity')).dataManager;
  return _dataManagerCache;
}

let _dataContextCache: any = null;
let _contextEntitiesEnumCache: any = null;
async function _dataContext() {
  if (!_dataContextCache) {
    const mod = await import('../FlowSync/context');
    _dataContextCache = mod.dataContext;
    _contextEntitiesEnumCache = mod.ContextEntitiesEnum;
  }
  return _dataContextCache;
}
async function _currentUserKey() {
  if (!_contextEntitiesEnumCache) await _dataContext();
  return _contextEntitiesEnumCache.CloudUserTypeId;
}

export interface CloudLoginResult {
  status: 'logged_in';
  user: User;
}

// Back-compat alias — older imports still reach for this.
export type HubWsStatus = HubConnectionStatus;

interface DesktopInfoSeed {
  cloud_login_available?: boolean;
  cloud_url?: string | null;
  cloud_app_url?: string | null;
  // New nested shape (preferred).
  login?: { status: HubLoginStatus; user: Record<string, unknown> | null; reason: string | null };
  connection?: { status: HubConnectionStatus; error: string | null };
  // Deprecated flat aliases — kept for one release.
  hub_ws_connected?: boolean;
  hub_ws_verified?: boolean;
  hub_ws_status?: HubConnectionStatus;
  hub_ws_error?: string | null;
}

/** The cloud-relevant slice of the graph bootstrap response. */
export interface CloudBootstrapSeed {
  user?: User | Record<string, unknown> | null;
  desktop_info?: DesktopInfoSeed | null;
}

export interface CloudStatusData extends DesktopInfoSeed {
  logged_in?: boolean;
  user?: Record<string, unknown> | null;
}

/**
 * Last hub HTTP error captured from a `hub_client_error_msg` WS broadcast.
 *
 * Lives on its own slot (not on the connection-status slot) — a 4xx/5xx from
 * a hub HTTP call is a request-level failure, not a WebSocket connectivity
 * problem. Surfaced through the warnings system so the user can see + copy
 * the full detail; auto-cleared on explicit dismiss.
 */
export interface HubClientErrorInfo {
  method: string;
  path: string;
  statusCode: number;
  message: string;
  /** ms since epoch when the error was observed on the UI side. */
  ts: number;
}

export interface CloudWsControlResult {
  hub_ws_connected: boolean;
  hub_ws_verified: boolean;
  hub_ws_status: HubConnectionStatus;
  hub_ws_error?: string | null;
  connection?: { status: HubConnectionStatus; error: string | null };
  verification?: {
    verified: boolean;
    local_user_id?: string;
    hub_user_id?: string;
    hub_user?: Record<string, unknown>;
  };
}

/** Convert the SDK API base to the browser-app origin used for dock links. */
export function hubAppUrlFromApiUrl(apiUrl: string | null | undefined): string {
  const normalized = (apiUrl ?? '').replace(/\/+$/, '');
  return normalized.endsWith(API_PREFIX) ? normalized.slice(0, -API_PREFIX.length) : normalized;
}

function legacyConnectionStatus(d: Partial<DesktopInfoSeed | CloudWsControlResult>): HubConnectionStatus | null {
  if (d.hub_ws_status) return d.hub_ws_status as HubConnectionStatus;
  if (d.hub_ws_verified) return 'verified';
  if (d.hub_ws_connected) return 'connected';
  return null;
}

class CloudManager extends EventEmitter {
  private _login: LoginSlot<HubLoginStatus> = makeLoginSlot<HubLoginStatus>('logged_out');
  private _currentUser: User | null = null;
  private _cloudUrl = '';
  private _cloudAppUrl = '';
  private _connection: ConnectionSlot<HubConnectionStatus> = makeConnectionSlot<HubConnectionStatus>('disconnected');
  private _lastHubError: HubClientErrorInfo | null = null;
  private _pending: { resolve: (r: CloudLoginResult) => void; reject: (e: Error) => void; off: () => void } | null =
    null;
  private _initialized = false;
  private _subscriptions: Promise<void> | null = null;

  /** Adopt known identity without fetching status or starting live services. */
  async seedBootstrap(bootstrap: CloudBootstrapSeed) {
    if (this._initialized) return;
    this._initialized = true;

    if (isHubOnly()) {
      // Hub-mode API traffic uses the configured hub origin directly. Keep the
      // status tooltip truthful when the UI is served by a separate Vite port.
      this._cloudUrl = sdkConfig.apiUrl;
      // In Hub mode the browser is already on the application origin. This is
      // also correct for the mandated split local harness (UI :4098, API
      // :8093), where deriving an app URL from the API origin would be wrong.
      this._cloudAppUrl = window.location.origin;

      const { ConnectionManager } = await import('../websocket');
      const cm = ConnectionManager.getInstance();
      const localConnection = cm.connectionSlot;
      this._applyConnectionStatus(localConnection.status, localConnection.error, false);

      if (bootstrap.user) {
        await this._setLoggedIn(bootstrap.user as unknown as Record<string, unknown>);
      } else {
        await this._setLoggedOut();
        // The hub surface has no anonymous mode: a session-less load (first
        // visit, expired or cleared cookie, post-logout reload) goes straight
        // to the provider login instead of rendering a signed-out shell.
        window.location.assign(this._hubLoginUrl());
      }
      return;
    }

    const seed = bootstrap.desktop_info;
    this._cloudUrl = seed?.cloud_url ?? '';
    this._cloudAppUrl = seed?.cloud_app_url ?? hubAppUrlFromApiUrl(this._cloudUrl);

    if (seed?.login) {
      // Adopt the identity at FIRST PAINT, not one round trip later. This branch
      // used to call `_applyLoginStatus` directly, which records a status and
      // leaves `dataContext.cloudUser` null — and the UI renders
      // `cloudUser ?? localUser`, so a cloud sandbox painted the template's own
      // "E2B Local" account until an async /cloud/status corrected it. On a cold
      // resume that call loses the race against a still-waking backend.
      await this._applyLoginBlock(seed.login, false);
    } else if (seed?.cloud_login_available) {
      // No identity to adopt: an older server that only answers "could you log
      // in from here". Status only, user null — the shape that caused the bug
      // above, kept solely so a new client still works against an old server.
      this._applyLoginStatus('logged_in', null, null, false);
    }
    if (seed?.connection) {
      this._applyConnectionStatus(seed.connection.status, seed.connection.error ?? null, false);
    } else {
      const legacy = legacyConnectionStatus(seed ?? {});
      if (legacy) this._applyConnectionStatus(legacy, seed?.hub_ws_error ?? null, false);
    }
    await this._mirrorToContext();
  }

  /** Register live listeners before the SDK proactively connects its socket. */
  startSubscriptions(): Promise<void> {
    return this._subscriptions ??= this._startSubscriptions();
  }

  private async _startSubscriptions(): Promise<void> {
    const { ConnectionManager } = await import('../websocket');
    const cm = ConnectionManager.getInstance();
    if (isHubOnly()) {
      cm.on('connection_status_changed', (slot: ConnectionSlot<LocalConnectionStatus>) => {
        this._applyConnectionStatus(slot.status, slot.error);
      });
      this._applyConnectionStatus(cm.connectionSlot.status, cm.connectionSlot.error);
      return;
    }
    const dm = await _dataManager();
    dm.on('on_oauth_msg', (msg: OAuthMessage) => this._onOAuthMessage(msg));
    // The cloud login/connection status pushes are emitted on the
    // ConnectionManager — NOT re-emitted by the dataManager (which only
    // forwards on_oauth_msg & friends, see store.ts attach_connection_manager).
    // Subscribing on `dm` here left these handlers dead, so the connection slot
    // never updated from a push and the avatar dot sat orange until a manual
    // refresh pulled /cloud/status. Listen on `cm`, where they actually fire.
    cm.on('on_cloud_login_status_msg', (msg: CloudLoginStatusMessage) => {
      void this._onCloudLoginStatusMsg(msg);
    });
    cm.on('on_cloud_connection_status_msg', (msg: CloudConnectionStatusMessage) => {
      this._onCloudConnectionStatusMsg(msg);
    });
    // Legacy fallback — back-compat for one release.
    cm.on('on_auth_expired_msg', (msg: { reason?: string }) => {
      void this._onCloudLoginStatusMsg({
        message_type: 'cloud_login_status_msg',
        status: 'logged_out',
        user: null,
        reason: msg.reason ?? 'rejected',
      } as CloudLoginStatusMessage);
    });
    cm.on('on_hub_client_error_msg', (msg: Record<string, unknown>) => this._onHubClientError(msg));
    // Resync after a local-WS reconnect: connection-status broadcasts that
    // landed while the socket was down would otherwise be lost forever,
    // leaving the avatar stuck on whatever state we saw last.
    cm.on('on_reconnected', () => {
      void this.refreshStatus().catch(() => {});
    });
  }

  /** Compatibility entry point for callers that want the complete startup. */
  async bootstrap(bootstrap: CloudBootstrapSeed): Promise<void> {
    await this.seedBootstrap(bootstrap);
    await this.startSubscriptions();
    await this.refreshStatus();
  }

  /**
   * Adopt a `{status, user, reason}` login block — the shape both the graph
   * bootstrap seed and `GET /cloud/status` carry, from the same server builder.
   *
   * One handler for both, because the alternative is what caused the bug this
   * exists to fix: two places deciding "who am I" drift, and the one that drifted
   * only applied a STATUS while leaving `dataContext.cloudUser` empty — so the UI
   * fell back to the box's own local account.
   *
   * `_setLoggedIn` is the load-bearing call: `_applyLoginStatus` sets the login
   * slot and nothing else, so a `logged_in` block WITH a user must not go through
   * it alone.
   */
  private async _applyLoginBlock(
    login: { status: HubLoginStatus; user: Record<string, unknown> | null; reason: string | null },
    emit = true,
  ): Promise<void> {
    if (login.status === 'logged_in' && login.user) {
      await this._setLoggedIn(login.user);
    } else if (login.status === 'logged_out') {
      await this._setLoggedOut();
    } else {
      this._applyLoginStatus(login.status, login.user, login.reason, emit);
    }
  }

  /** Hub-mode login URL. Carries where to come back to as ``target_path`` so the
   *  provider round-trip lands the browser back there — the hub validates the
   *  value against its open-redirect allowlist (``AuthProvider.safe_target_path``)
   *  and falls back to `/` otherwise.
   *
   *  That is usually the current SPA location, but NOT on the load that follows
   *  an email verification: there the current location is the app root Auth0
   *  returns every verified account to, and using it stranded a first-time
   *  invitee on hub home holding a role nothing had told them about. Measured on
   *  staging — the invitation's accept url rode `target_path` all the way to
   *  `email-verification.html`, which stored it, and this line then replaced it
   *  with `/?success=true&message=…`. `resolveLoginCallbackUrl` is what hands it
   *  back. */
  private _hubLoginUrl(): string {
    const here = `${window.location.pathname || ''}${window.location.search || ''}`;
    const target = resolveLoginCallbackUrl(here);
    if (!target || target === '/') return `${API_PREFIX}/login`;
    return `${API_PREFIX}/login?${new URLSearchParams({ target_path: target })}`;
  }

  async login(): Promise<CloudLoginResult | void> {
    if (isHubOnly()) {
      window.location.assign(this._hubLoginUrl());
      return;
    }

    // Hard gate: in Local (private) data-privacy mode the cloud is off-limits.
    // The UI guard + hidden login button handle the user-facing copy; this is
    // the defensive SDK-side check (the backend 403s independently).
    if (privacyManager.isLocal) {
      throw new Error('Login disabled in Local mode');
    }

    if (!(await this._ensureSecretsEnabled())) {
      throw new Error('Login canceled');
    }

    this._rejectPending('superseded by new login attempt');

    this._applyLoginStatus('logging_in', null, null);

    const promise = new Promise<CloudLoginResult>((resolve, reject) => {
      const handler = async (msg: OAuthMessage) => {
        if (msg.oauth_request_id !== OAUTH_PROVIDERS.FLOWPAD_CLOUD) return;
        await this._handleOAuthCompletion(msg, resolve, reject);
      };
      _dataManager().then((dm) => dm.on('on_oauth_msg', handler));
      const off = () => _dataManager().then((dm) => dm.off('on_oauth_msg', handler));
      this._pending = { resolve, reject, off };
    });

    try {
      await apiClient.post('/cloud/login');
    } catch (err: any) {
      const message = err?.response?.data?.message ?? err?.message ?? 'Login request failed';
      this._applyLoginStatus('login_failed', null, message);
      await this._pushFailureWarning(message);
      this._rejectPending(message);
      throw new Error(message);
    }

    return promise;
  }

  /**
   * @param returnTo Hub mode only: where the provider sends the browser after
   *   logout (e.g. a login-with-callback URL so an invitee can re-auth as the
   *   correct account and land back on the accept flow). The hub validates it
   *   server-side. Ignored on the desktop path.
   */
  async logout(returnTo?: string): Promise<void> {
    if (isHubOnly()) {
      // Hub server: logout MUST be a top-level navigation through the hub's
      // redirect chain, not an XHR. The chain is hub /logout (clears the hub
      // cookies) → Auth0 /v2/logout (ends the IdP SSO session) → returnTo.
      // An XHR can't ride the cross-origin Auth0 hop — the browser won't
      // send Auth0's cookies on it — so the SSO session survived and the
      // very next /login silently re-authenticated the same account: logout
      // appeared to do nothing (landed back on home, no login form), and the
      // wrong-account re-auth flow could never switch users. Custom-JWT hubs
      // ride the same chain, just without the IdP hop. `returnTo` goes to
      // the hub as a query param — the server owns its validation/wrapping.
      await this._setLoggedOut();
      const qs = returnTo ? `?${new URLSearchParams({ returnTo })}` : '';
      window.location.assign(`${API_PREFIX}/logout${qs}`);
      return;
    }

    const data = await apiClient.post<{ cloud_logout_url: string }>('/cloud/logout');
    // Server broadcasts LOGGED_OUT + DISCONNECTED; mirror immediately for snappy UI.
    await this._setLoggedOut();
    if (data?.cloud_logout_url) {
      const { BrowserAuthWindow } = await import('./oauth/oauth-window');
      new BrowserAuthWindow().open(data.cloud_logout_url);
    }
  }

  async connectHubWs(): Promise<CloudWsControlResult> {
    if (!this.isLoggedIn) {
      const message = 'Cloud login required before connecting hub WebSocket.';
      await this._pushFailureWarning(message);
      throw new Error(message);
    }

    this._applyConnectionStatus('connecting', null);
    try {
      const data = await apiClient.post<CloudWsControlResult>('/cloud/ws/connect');
      this._applyConnectionFromResponse(data);
      return data;
    } catch (err: any) {
      const message = this._errorMessage(err, 'Hub WebSocket connect failed');
      this._applyConnectionStatus('error', message);
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
  }

  async disconnectHubWs(): Promise<CloudWsControlResult> {
    try {
      const data = await apiClient.post<CloudWsControlResult>('/cloud/ws/disconnect');
      this._applyConnectionFromResponse(data);
      return data;
    } catch (err: any) {
      const message = this._errorMessage(err, 'Hub WebSocket disconnect failed');
      this._applyConnectionStatus('error', message);
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
  }

  async verifyHubWs(): Promise<CloudWsControlResult> {
    if (!this.isLoggedIn) {
      const message = 'Cloud login required before verifying hub WebSocket.';
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
    try {
      const data = await apiClient.post<CloudWsControlResult>('/cloud/ws/verify');
      this._applyConnectionFromResponse(data);
      return data;
    } catch (err: any) {
      const message = this._errorMessage(err, 'Hub WebSocket verification failed');
      this._applyConnectionStatus('error', message);
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
  }

  async refreshStatus(): Promise<CloudStatusData | null> {
    return lazyAssets.refresh(LazyAsset.CloudStatus);
  }

  /** @deprecated Listen to login_status_changed / connection_status_changed instead. */
  async handleAuthExpired(reason = 'rejected'): Promise<void> {
    await this._setLoggedOut();
    this.emit('auth_expired', { reason, message: this._connection.error ?? '' });
  }

  // --- public read API ---

  get isLoggedIn() {
    return this._login.status === 'logged_in';
  }
  get currentUser() {
    return this._currentUser;
  }
  get cloudUrl() {
    return this._cloudUrl;
  }
  get cloudAppUrl() {
    return this._cloudAppUrl;
  }
  /** Manual bridge controls exist only on the desktop backend. */
  get connectionControlsAvailable() {
    return !isHubOnly();
  }

  // New canonical getters
  get loginStatus(): HubLoginStatus {
    return this._login.status;
  }
  get loginSlot(): Readonly<LoginSlot<HubLoginStatus>> {
    return this._login;
  }
  get connectionStatus(): HubConnectionStatus {
    return this._connection.status;
  }
  get connectionSlot(): Readonly<ConnectionSlot<HubConnectionStatus>> {
    return this._connection;
  }

  // Back-compat getters — derived from the slots.
  get hubWsConnected() {
    return isHubConnected(this._connection.status);
  }
  get hubWsVerified() {
    return this._connection.status === 'verified';
  }
  get hubWsStatus(): HubConnectionStatus {
    return this._connection.status;
  }
  get hubWsError(): string | null {
    return this._connection.error;
  }
  get cloudStatus(): CloudStatusData {
    return {
      logged_in: this.isLoggedIn,
      user: this._currentUser ? (this._currentUser as unknown as Record<string, unknown>) : null,
      cloud_url: this._cloudUrl,
      cloud_app_url: this._cloudAppUrl,
      // new nested
      login: { status: this._login.status, user: this._login.user, reason: this._login.reason },
      connection: { status: this._connection.status, error: this._connection.error },
      // legacy flat
      hub_ws_connected: this.hubWsConnected,
      hub_ws_verified: this.hubWsVerified,
      hub_ws_status: this._connection.status,
      hub_ws_error: this._connection.error,
    };
  }

  // --- internals ---

  private async _ensureSecretsEnabled(): Promise<boolean> {
    try {
      const initial = await secretsService.isEnabled();
      if (initial?.enabled) return true;
    } catch {
      /* probe failed (offline/server down) — fall through to the dialog */
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

  private async _onOAuthMessage(msg: OAuthMessage) {
    if (msg.oauth_request_id !== OAUTH_PROVIDERS.FLOWPAD_CLOUD) return;
    if (this._pending) return;
    if (msg.status === 'success' && msg.user) {
      await this._setLoggedIn(msg.user as Record<string, unknown>);
    }
  }

  /**
   * Detach and reject the in-flight login promise, if any. A method rather than
   * inline statements so the `_pending` read is a fresh one: the object is
   * assigned inside the `new Promise` executor, which the compiler's flow
   * analysis cannot see through.
   */
  private _rejectPending(message: string): void {
    const pending = this._pending;
    if (!pending) return;
    pending.off();
    pending.reject(new Error(message));
    this._pending = null;
  }

  private async _handleOAuthCompletion(
    msg: OAuthMessage,
    resolve: (r: CloudLoginResult) => void,
    reject: (e: Error) => void,
  ) {
    if (!this._pending) return;
    this._pending.off();
    this._pending = null;

    if (msg.status === 'success' && msg.user) {
      const user = await this._setLoggedIn(msg.user as Record<string, unknown>);
      resolve({ status: 'logged_in', user });
    } else {
      const message = msg.message ?? 'Authentication was rejected';
      this._applyLoginStatus('login_failed', null, message);
      await this._pushFailureWarning(message);
      reject(new Error(message));
    }
  }

  private async _setLoggedIn(userDict: Record<string, unknown>): Promise<User> {
    const dm = await _dataManager();
    // `type` LAST, deliberately. The hub answers /current-user with the principal
    // it actually authenticated, which for a deployed agent is `"type": "identity"`
    // — a type `EntityFactory` has no constructor for, so a spread landing after
    // `type` makes this throw and the sandbox silently falls back to its own local
    // user. The cloud principal is always modelled here as a User; only its FIELDS
    // (name, avatar, id) vary by principal kind.
    const cloudUser = dm.updateEntityFromJson<User>({ ...userDict, type: User.type });
    if (this.isLoggedIn && this._currentUser && this._currentUser.typeId?.toString() === cloudUser.typeId?.toString()) {
      return this._currentUser;
    }
    cloudUser.markAsExpanded();
    this._currentUser = cloudUser;
    const ctx = await _dataContext();
    ctx.setCloudLoggedIn?.(true);
    await ctx.setContextEntityTypeId(await _currentUserKey(), cloudUser.typeId);
    this._applyLoginStatus('logged_in', userDict, null);
    this.emit('login_complete', { user: cloudUser });
    return cloudUser;
  }

  private async _setLoggedOut() {
    this._currentUser = null;
    const ctx = await _dataContext();
    await ctx.setContextEntityTypeId(await _currentUserKey(), null);
    ctx.setCloudLoggedIn?.(false);
    this._applyLoginStatus('logged_out', null, null);
    // Connection state is owned by its own channel; logout-driven
    // DISCONNECTED arrives via cloud_connection_status_msg.
    this.emit('logout_complete');
  }

  /** Apply a new login slot value. Emits login_status_changed + cloud_status_changed. */
  private _applyLoginStatus(
    status: HubLoginStatus,
    user: Record<string, unknown> | null,
    reason: string | null,
    emit = true,
  ) {
    const prev = this._login.status;
    this._login = { status, user, reason };
    void _dataContext().then((ctx) => ctx.setCloudLoginStatus?.(status));
    if (emit) {
      if (prev !== status) this.emit('login_status_changed', this._login);
      this.emit('cloud_status_changed', this.cloudStatus);
    }
  }

  /** Apply a new connection slot value. Emits connection_status_changed + cloud_status_changed. */
  private _applyConnectionStatus(status: HubConnectionStatus, error: string | null, emit = true) {
    const prev = this._connection.status;
    const prevError = this._connection.error;
    this._connection = { status, error };
    void _dataContext().then((ctx) => ctx.setCloudConnectionStatus?.(status));
    if (emit) {
      if (prev !== status || prevError !== error) this.emit('connection_status_changed', this._connection);
      this.emit('cloud_status_changed', this.cloudStatus);
    }
  }

  private _applyConnectionFromResponse(data: Partial<CloudWsControlResult> | null | undefined) {
    if (!data) return;
    if (data.connection) {
      this._applyConnectionStatus(data.connection.status, data.connection.error ?? null);
      return;
    }
    const legacy = legacyConnectionStatus(data);
    if (legacy) this._applyConnectionStatus(legacy, data.hub_ws_error ?? null);
  }

  private async _mirrorToContext() {
    const ctx = await _dataContext();
    ctx.setCloudLoggedIn?.(this.isLoggedIn);
  }

  async fetchStatus(isCurrent: () => boolean = () => true): Promise<CloudStatusData | null> {
    // No cloud layer to refresh in these modes, so don't hit `/cloud/status`:
    //  - Hub mode: the hub backend has no such route (404).
    //  - Local (private) data-privacy mode: the cloud is off-limits by contract
    //    (see login()'s hard gate). Gating here — not just at the callers — keeps
    //    bootstrap's unconditional on-load refresh and on_reconnected both correct.
    if (isHubOnly() || privacyManager.isLocal) return null;
    const data = await apiClient.get<CloudStatusData>('/cloud/status');
    if (!isCurrent()) throw new Error('SDK scope changed');
    if (data?.cloud_url) this._cloudUrl = data.cloud_url;
    if (data?.cloud_app_url) this._cloudAppUrl = data.cloud_app_url;
    else if (data?.cloud_url) this._cloudAppUrl = hubAppUrlFromApiUrl(data.cloud_url);

    // Prefer nested shape; fall back to legacy aliases.
    if (data?.connection) {
      this._applyConnectionStatus(data.connection.status, data.connection.error ?? null, false);
    } else {
      const legacy = legacyConnectionStatus(data ?? {});
      if (legacy) this._applyConnectionStatus(legacy, data?.hub_ws_error ?? null, false);
    }

    if (data?.login) {
      await this._applyLoginBlock(data.login);
    } else if (data?.logged_in && data.user) {
      await this._setLoggedIn(data.user);
    } else if (data?.logged_in === false) {
      await this._setLoggedOut();
    } else {
      this.emit('cloud_status_changed', this.cloudStatus);
    }
    return data;
  }

  private async _onCloudLoginStatusMsg(msg: CloudLoginStatusMessage) {
    const status = msg.status;
    const user = (msg.user ?? null) as Record<string, unknown> | null;
    const reason = msg.reason ?? null;
    if (status === 'logged_in' && user) {
      await this._setLoggedIn(user);
    } else if (status === 'logged_out') {
      await this._setLoggedOut();
    } else if (status === 'login_failed') {
      this._applyLoginStatus('login_failed', null, reason);
      this.emit('login_failed', { message: reason ?? 'Login failed' });
    } else {
      this._applyLoginStatus(status, user, reason);
    }
  }

  private _onCloudConnectionStatusMsg(msg: CloudConnectionStatusMessage) {
    this._applyConnectionStatus(msg.status, msg.error ?? null);
  }

  private _onHubClientError(msg: Record<string, unknown>) {
    const method = String(msg.method ?? '');
    const path = String(msg.path ?? '');
    const statusCode = Number(msg.status_code ?? 0);
    const message = String(msg.message ?? 'Hub client error');
    // Record on its own slot — request-level HTTP errors do NOT belong on
    // the connection slot (that's for WS connectivity state). Putting them
    // there clobbered the real WS error message and made unrelated 404s
    // surface in Settings as "connection error".
    this._lastHubError = { method, path, statusCode, message, ts: Date.now() };
    this.emit('hub_client_error', msg);
    this.emit('last_hub_error_changed', this._lastHubError);
  }

  /** Most recent hub HTTP error, or null if none / dismissed. */
  get lastHubError(): HubClientErrorInfo | null {
    return this._lastHubError;
  }

  /** Dismiss the last hub HTTP error — clears the warning. */
  clearLastHubError(): void {
    if (this._lastHubError === null) return;
    this._lastHubError = null;
    this.emit('last_hub_error_changed', null);
  }

  private _errorMessage(err: any, fallback: string): string {
    return err?.response?.data?.message ?? err?.message ?? fallback;
  }

  private async _pushFailureWarning(message: string) {
    const ctx = await _dataContext();
    ctx.addWarning?.(createCloudLoginFailedWarning(message));
    this.emit('login_failed', { message });
  }
}

export const cloudManager = new CloudManager();
export const cloudLogin = () => cloudManager.login();
export const cloudLogout = () => cloudManager.logout();
export const getCloudStatus = (): Promise<CloudStatusData | null> =>
  // Hub mode: `/cloud/status` is not implemented on the hub backend (404).
  isHubOnly() ? Promise.resolve(null) : apiClient.get<CloudStatusData>('/cloud/status');

export default cloudManager;
