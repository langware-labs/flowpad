/**
 * Cloud login — single owner of cloud auth on the SDK side.
 *
 * Mirrors the DataManager pattern from FlowSync/store.ts (EventEmitter +
 * dataContext mirror). Frontend never picks env-mode vs browser-mode —
 * cloud_login.py decides server-side. UI calls `cloudManager.login()`,
 * the Promise resolves on a WS oauth event or rejects with a footer warning.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import { User } from '../entities/user';
import { createCloudLoginFailedWarning } from '../models/UserWarning';
import type { OAuthMessage } from '../websocket';
import { OAUTH_PROVIDERS } from './oauth/oauth-service';
import { secretApprovalGate } from './secretApprovalGate';
import { secretsService } from './secrets-service';

// Lazy imports break the cycle: context.ts can no longer import this module
// at top level (it does dynamic-import for the cloudLogout delegate only).
let _dataManagerCache: any = null;
async function _dataManager() {
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
  return _contextEntitiesEnumCache.CurrentUserTypeId;
}

export interface CloudLoginResult {
  status: 'logged_in';
  user: User;
}

export type HubWsStatus = 'disconnected' | 'connecting' | 'connected' | 'verified' | 'error';

interface DesktopInfoSeed {
  cloud_login_available?: boolean;
  cloud_url?: string | null;
  hub_ws_connected?: boolean;
  hub_ws_verified?: boolean;
  hub_ws_status?: HubWsStatus;
  hub_ws_error?: string | null;
}

export interface CloudStatusData extends DesktopInfoSeed {
  logged_in?: boolean;
  user?: Record<string, unknown> | null;
}

export interface CloudWsControlResult {
  hub_ws_connected: boolean;
  hub_ws_verified: boolean;
  hub_ws_status: HubWsStatus;
  hub_ws_error?: string | null;
  verification?: {
    verified: boolean;
    local_user_id?: string;
    hub_user_id?: string;
    hub_user?: Record<string, unknown>;
  };
}

class CloudManager extends EventEmitter {
  private _isLoggedIn = false;
  private _currentUser: User | null = null;
  private _cloudUrl = '';
  private _hubWsConnected = false;
  private _hubWsVerified = false;
  private _hubWsStatus: HubWsStatus = 'disconnected';
  private _hubWsError: string | null = null;
  private _pending: { resolve: (r: CloudLoginResult) => void; reject: (e: Error) => void; off: () => void } | null = null;
  private _initialized = false;

  /** Seed initial state from bootstrapInfo.desktop_info. Called once from main.ts. */
  async bootstrap(seed: DesktopInfoSeed | null | undefined) {
    if (this._initialized) return;
    this._initialized = true;
    this._isLoggedIn = !!seed?.cloud_login_available;
    this._cloudUrl = seed?.cloud_url ?? '';
    this._applyHubWsStatus(seed);
    await this._mirrorToContext();

    const dm = await _dataManager();
    dm.on('on_oauth_msg', (msg: OAuthMessage) => this._onOAuthMessage(msg));
    const { ConnectionManager } = await import('../websocket');
    const cm = ConnectionManager.getInstance();
    cm.on('on_auth_expired_msg', (msg: { reason?: string }) => {
      void this.handleAuthExpired(msg.reason ?? 'rejected');
    });
    cm.on('on_hub_client_error_msg', (msg: Record<string, unknown>) => this._onHubClientError(msg));

    if (this._isLoggedIn) await this._refreshFromStatus();
  }

  async login(): Promise<CloudLoginResult> {
    if (!(await this._ensureSecretsEnabled())) {
      throw new Error('Login canceled');
    }

    if (this._pending) {
      this._pending.off();
      this._pending.reject(new Error('superseded by new login attempt'));
      this._pending = null;
    }

    const promise = new Promise<CloudLoginResult>((resolve, reject) => {
      // Subscribe BEFORE the POST — env-mode WS event may arrive instantly.
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
      await this._pushFailureWarning(message);
      this._pending?.off();
      this._pending?.reject(new Error(message));
      this._pending = null;
      throw new Error(message);
    }

    return promise;
  }

  async logout(): Promise<void> {
    const data = await apiClient.post<{ cloud_logout_url: string }>('/cloud/logout');
    await this._setLoggedOut();
    if (data?.cloud_logout_url) {
      const { BrowserAuthWindow } = await import('./oauth/oauth-window');
      new BrowserAuthWindow().open(data.cloud_logout_url);
    }
  }

  async connectHubWs(): Promise<CloudWsControlResult> {
    if (!this._isLoggedIn) {
      const message = 'Cloud login required before connecting hub WebSocket.';
      await this._pushFailureWarning(message);
      throw new Error(message);
    }

    this._applyHubWsStatus({ hub_ws_status: 'connecting', hub_ws_connected: false, hub_ws_verified: false, hub_ws_error: null });
    try {
      const data = await apiClient.post<CloudWsControlResult>('/cloud/ws/connect');
      this._applyHubWsStatus(data);
      return data;
    } catch (err: any) {
      const message = this._errorMessage(err, 'Hub WebSocket connect failed');
      this._applyHubWsStatus({ hub_ws_status: 'error', hub_ws_connected: false, hub_ws_verified: false, hub_ws_error: message });
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
  }

  async disconnectHubWs(): Promise<CloudWsControlResult> {
    try {
      const data = await apiClient.post<CloudWsControlResult>('/cloud/ws/disconnect');
      this._applyHubWsStatus(data);
      return data;
    } catch (err: any) {
      const message = this._errorMessage(err, 'Hub WebSocket disconnect failed');
      this._applyHubWsStatus({ hub_ws_status: 'error', hub_ws_error: message });
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
  }

  async verifyHubWs(): Promise<CloudWsControlResult> {
    if (!this._isLoggedIn) {
      const message = 'Cloud login required before verifying hub WebSocket.';
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
    try {
      const data = await apiClient.post<CloudWsControlResult>('/cloud/ws/verify');
      this._applyHubWsStatus(data);
      return data;
    } catch (err: any) {
      const message = this._errorMessage(err, 'Hub WebSocket verification failed');
      this._applyHubWsStatus({ hub_ws_status: 'error', hub_ws_verified: false, hub_ws_error: message });
      await this._pushFailureWarning(message);
      throw new Error(message);
    }
  }

  async refreshStatus(): Promise<CloudStatusData | null> {
    return this._refreshFromStatus();
  }

  async handleAuthExpired(reason = 'rejected'): Promise<void> {
    await this._setLoggedOut();
    const message = reason === 'expired' ? 'Cloud login expired.' : 'Cloud login was rejected by the hub.';
    this._hubWsError = message;
    this.emit('auth_expired', { reason, message });
    this.emit('cloud_status_changed', this.cloudStatus);
  }

  get isLoggedIn() { return this._isLoggedIn; }
  get currentUser() { return this._currentUser; }
  get cloudUrl() { return this._cloudUrl; }
  get hubWsConnected() { return this._hubWsConnected; }
  get hubWsVerified() { return this._hubWsVerified; }
  get hubWsStatus() { return this._hubWsStatus; }
  get hubWsError() { return this._hubWsError; }
  get cloudStatus(): CloudStatusData {
    return {
      logged_in: this._isLoggedIn,
      user: this._currentUser ? (this._currentUser as unknown as Record<string, unknown>) : null,
      cloud_url: this._cloudUrl,
      hub_ws_connected: this._hubWsConnected,
      hub_ws_verified: this._hubWsVerified,
      hub_ws_status: this._hubWsStatus,
      hub_ws_error: this._hubWsError,
    };
  }

  // --- internals ---

  private async _ensureSecretsEnabled(): Promise<boolean> {
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

  private async _onOAuthMessage(msg: OAuthMessage) {
    if (msg.oauth_request_id !== OAUTH_PROVIDERS.FLOWPAD_CLOUD) return;
    // If a login() Promise is in flight, _handleOAuthCompletion will own this msg —
    // skip the manager-level fan-out to avoid double-firing _setLoggedIn.
    if (this._pending) return;
    if (msg.status === 'success' && msg.user) {
      await this._setLoggedIn(msg.user as Record<string, unknown>);
    }
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
      void this._refreshFromStatus();
      resolve({ status: 'logged_in', user });
    } else {
      const message = msg.message ?? 'Authentication was rejected';
      await this._pushFailureWarning(message);
      reject(new Error(message));
    }
  }

  private async _setLoggedIn(userDict: Record<string, unknown>): Promise<User> {
    const cloudUser = new User(userDict);
    // Idempotent: re-broadcasts of the same user are no-ops.
    if (this._isLoggedIn && this._currentUser?.typeId?.toString() === cloudUser.typeId?.toString()) {
      return this._currentUser;
    }
    cloudUser.markAsExpanded();
    this._currentUser = cloudUser;
    this._isLoggedIn = true;
    const ctx = await _dataContext();
    ctx.setCloudLoggedIn?.(true);
    await ctx.setContextEntityTypeId(await _currentUserKey(), cloudUser.typeId);
    this.emit('login_complete', { user: cloudUser });
    this.emit('cloud_status_changed', this.cloudStatus);
    return cloudUser;
  }

  private async _setLoggedOut() {
    this._isLoggedIn = false;
    this._currentUser = null;
    this._applyHubWsStatus({ hub_ws_status: 'disconnected', hub_ws_connected: false, hub_ws_verified: false, hub_ws_error: null }, false);
    const ctx = await _dataContext();
    await ctx.setContextEntityTypeId(await _currentUserKey(), null);
    ctx.setCloudLoggedIn?.(false);
    this.emit('logout_complete');
    this.emit('cloud_status_changed', this.cloudStatus);
  }

  private async _mirrorToContext() {
    const ctx = await _dataContext();
    ctx.setCloudLoggedIn?.(this._isLoggedIn);
  }

  private async _refreshFromStatus(): Promise<CloudStatusData | null> {
    try {
      const data = await apiClient.get<CloudStatusData>('/cloud/status');
      if (data?.cloud_url) this._cloudUrl = data.cloud_url;
      this._applyHubWsStatus(data, false);
      if (data?.logged_in && data.user) {
        await this._setLoggedIn(data.user);
      } else if (data?.logged_in === false) {
        await this._setLoggedOut();
      } else {
        this.emit('cloud_status_changed', this.cloudStatus);
      }
      return data;
    } catch {
      // non-critical: manager state stays as seeded
      return null;
    }
  }

  private _applyHubWsStatus(data?: Partial<CloudStatusData | CloudWsControlResult> | null, emit = true) {
    if (!data) return;
    if ('hub_ws_connected' in data && typeof data.hub_ws_connected === 'boolean') this._hubWsConnected = data.hub_ws_connected;
    if ('hub_ws_verified' in data && typeof data.hub_ws_verified === 'boolean') this._hubWsVerified = data.hub_ws_verified;
    if ('hub_ws_status' in data && data.hub_ws_status) this._hubWsStatus = data.hub_ws_status as HubWsStatus;
    if ('hub_ws_error' in data) this._hubWsError = data.hub_ws_error ?? null;
    if (emit) this.emit('cloud_status_changed', this.cloudStatus);
  }

  private _onHubClientError(msg: Record<string, unknown>) {
    const method = String(msg.method ?? '');
    const path = String(msg.path ?? '');
    const status = String(msg.status_code ?? '');
    const message = String(msg.message ?? 'Hub client error');
    this._hubWsError = `${method} ${path} ${status}: ${message}`.trim();
    this.emit('hub_client_error', msg);
    this.emit('cloud_status_changed', this.cloudStatus);
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
export const getCloudStatus = () =>
  apiClient.get<CloudStatusData>('/cloud/status');

export default cloudManager;
