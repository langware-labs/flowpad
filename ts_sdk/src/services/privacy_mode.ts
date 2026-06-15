/**
 * Data-privacy mode — single owner of the Local/Connected state on the SDK side.
 *
 * Two modes:
 *   'connected' — sharing + cloud login enabled (default; today's behavior).
 *   'local'     — no data leaves the machine: cloud login, sharing, and all
 *                 outbound hub HTTP are disabled. Auto-update stays active.
 *
 * The backend is the authoritative enforcer (see
 * flow_sdk/instance_settings/privacy_mode.py); this manager mirrors the value
 * into dataContext for reactive UI, toggles via the privacy route, and listens
 * for live changes broadcast over WS. Mirrors the CloudManager pattern.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import type { PrivacyModeMessage } from '../websocket';

export type PrivacyMode = 'local' | 'connected';

class PrivacyManager extends EventEmitter {
  private _mode: PrivacyMode = 'connected';
  private _initialized = false;

  get mode(): PrivacyMode {
    return this._mode;
  }

  get isLocal(): boolean {
    return this._mode === 'local';
  }

  /** Seed initial state from bootstrapInfo.privacy_mode. Called once from main.ts. */
  async bootstrap(seedMode: PrivacyMode | string | null | undefined) {
    if (this._initialized) return;
    this._initialized = true;
    this._apply(seedMode === 'local' ? 'local' : 'connected');

    const { ConnectionManager } = await import('../websocket');
    const cm = ConnectionManager.getInstance();
    cm.on('on_privacy_mode_msg', (msg: PrivacyModeMessage) => {
      this._apply(msg.privacy_mode === 'local' ? 'local' : 'connected');
    });
  }

  /** Toggle to the other mode and persist. */
  async toggle(): Promise<PrivacyMode> {
    return this.setMode(this._mode === 'local' ? 'connected' : 'local');
  }

  /** Set the mode via the backend route; the WS broadcast confirms + mirrors. */
  async setMode(mode: PrivacyMode): Promise<PrivacyMode> {
    const data = await apiClient.post<{ privacy_mode: PrivacyMode }>('/privacy/mode', {
      privacy_mode: mode,
    });
    const stored = (data?.privacy_mode === 'local' ? 'local' : 'connected') as PrivacyMode;
    this._apply(stored);
    return stored;
  }

  private _apply(mode: PrivacyMode) {
    if (this._mode === mode) return;
    this._mode = mode;
    this.emit('privacy_mode_changed', mode);
  }
}

export const privacyManager = new PrivacyManager();
export default privacyManager;
