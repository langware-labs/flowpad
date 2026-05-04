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

interface DesktopInfoSeed {
  cloud_login_available?: boolean;
  cloud_url?: string | null;
}

class CloudManager extends EventEmitter {
  private _isLoggedIn = false;
  private _currentUser: User | null = null;
  private _cloudUrl = '';
  private _pending: { resolve: (r: CloudLoginResult) => void; reject: (e: Error) => void; off: () => void } | null = null;
  private _initialized = false;

  /** Seed initial state from bootstrapInfo.desktop_info. Called once from main.ts. */
  async bootstrap(seed: DesktopInfoSeed | null | undefined) {
    if (this._initialized) return;
    this._initialized = true;
    this._isLoggedIn = !!seed?.cloud_login_available;
    this._cloudUrl = seed?.cloud_url ?? '';
    await this._mirrorToContext();

    const dm = await _dataManager();
    dm.on('on_oauth_msg', (msg: OAuthMessage) => this._onOAuthMessage(msg));

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
    this._isLoggedIn = false;
    this._currentUser = null;
    const ctx = await _dataContext();
    ctx.setContextEntityTypeId(await _currentUserKey(), null);
    ctx.setCloudLoggedIn?.(false);
    this.emit('logout_complete');
    if (data?.cloud_logout_url) {
      const { BrowserAuthWindow } = await import('./oauth/oauth-window');
      new BrowserAuthWindow().open(data.cloud_logout_url);
    }
  }

  get isLoggedIn() { return this._isLoggedIn; }
  get currentUser() { return this._currentUser; }
  get cloudUrl() { return this._cloudUrl; }

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
    return cloudUser;
  }

  private async _mirrorToContext() {
    const ctx = await _dataContext();
    ctx.setCloudLoggedIn?.(this._isLoggedIn);
  }

  private async _refreshFromStatus() {
    try {
      const data = await apiClient.get<{ logged_in: boolean; user: Record<string, unknown>; cloud_url: string }>('/cloud/status');
      if (data?.cloud_url) this._cloudUrl = data.cloud_url;
      if (data?.logged_in && data.user) {
        await this._setLoggedIn(data.user);
      }
    } catch {
      // non-critical: manager state stays as seeded
    }
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
  apiClient.get<{ logged_in: boolean; user: any; cloud_url: string }>('/cloud/status');

export default cloudManager;
