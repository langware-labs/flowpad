import { load_config } from './load_config';

// Create the SDK configuration instance
export const sdkConfig = load_config();

// Export types and classes for direct access
export { SDKConfig } from './SDKConfig';
export type { ISDKConfig } from './types';
export { initDesktopBackend } from './desktop';

/**
 * The origin the backend answers on, or `null` when none is configured. A packaged UI served by its own
 * backend gets the page origin here; a split dev harness (Vite on one port, the hub on another) gets the
 * hub's -- which is exactly where a backend route lives and `window.location.origin` is not.
 */
export function backendOrigin(): string | null {
  return Number.isFinite(sdkConfig.api_port) ? new URL(sdkConfig.apiUrl).origin : null;
}
