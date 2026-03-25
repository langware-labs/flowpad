/**
 * Runtime backend URL resolution for Electron desktop app.
 *
 * In desktop mode, the backend port is chosen at startup and communicated
 * to the renderer via Electron IPC (window.electronAPI.getBackendUrl).
 * This module fetches the URL once, caches it, and updates the SDK config.
 */

import type { SDKConfig } from './SDKConfig';

let cachedBaseUrl: string | null = null;
let baseUrlPromise: Promise<string> | null = null;

/**
 * Resolve the backend URL from Electron IPC and update sdkConfig.
 * No-op when not running inside Electron.
 */
export async function initDesktopBackend(config: SDKConfig): Promise<void> {
  const w = window as any;
  if (!w?.electronAPI?.getBackendUrl) return;

  if (cachedBaseUrl) return;

  if (!baseUrlPromise) {
    baseUrlPromise = w.electronAPI.getBackendUrl().then((url: string) => {
      try {
        const parsed = new URL(url);
        config.api_protocol = parsed.protocol.replace(':', '');
        config.api_host = parsed.hostname;
        config.api_port = parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
      } catch {
        // keep existing config
      }
      cachedBaseUrl = url;
      return url;
    });
  }

  await baseUrlPromise;
}
