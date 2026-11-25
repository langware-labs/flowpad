import { ISDKConfig } from './types';
import { SDKConfig } from './SDKConfig';

declare const __API_URL__: string;
declare const __AUTH_PROVIDER__: string;
declare const __DEPLOY_ENV__: string;
declare const __FLOWPAD_APP_HOST__: string;
declare const __FLOWPAD_APP_PORT__: string;
declare const __FLOWPAD_DEV__: boolean;
declare const __CHECK_REFRESH_TOKEN__: boolean;
declare const __UI_VERSION__: string;

function parseApiConnectionPrimitives(apiUrl?: string): { api_protocol: string; api_host: string; api_port: number } {
  if (!apiUrl) {
    // No API URL configured - return invalid port to trigger error screen
    // Never fallback to window.location as it causes Vite proxy issues
    return { api_protocol: 'http', api_host: 'localhost', api_port: NaN };
  }

  try {
    const url = new URL(apiUrl);
    return {
      api_protocol: url.protocol.replace(':', ''),
      api_host: url.hostname,
      api_port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
    };
  } catch {
    return { api_protocol: 'http', api_host: 'localhost', api_port: 8000 };
  }
}

/**
 * The backend this SDK was loaded from, when the page itself is not served by it: a nano-app opened as a
 * `file://` in a browser imports `<backend>/sdk/flowpad-sdk.js`, and that origin is its backend. Undefined
 * for the app and for every page the backend serves (same origin: the paths above already decide).
 */
function loadedFrom(): string | undefined {
  try {
    const origin = new URL(import.meta.url).origin;
    return origin !== 'null' && origin !== globalThis.location?.origin ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function load_config(): SDKConfig {
  // Runtime backend override: a freshly re-evaluated SDK module graph (a "realm",
  // e.g. one per instance in the two-client hub test, or the Electron desktop
  // backend) can point itself at a backend by setting `globalThis.__FLOWPAD_API_URL__`
  // BEFORE the graph is imported — its `apiClient` baseURL is then fixed against it.
  // The default app path leaves this unset and flows through the compile-time define.
  if (typeof (globalThis as any).__FLOWPAD_API_URL__ !== 'string') {
    const origin = typeof __API_URL__ !== 'undefined' && __API_URL__ ? undefined : loadedFrom();
    if (origin) (globalThis as any).__FLOWPAD_API_URL__ = origin;
  }
  const runtimeApiUrl = (globalThis as any).__FLOWPAD_API_URL__;
  const apiUrl =
    typeof runtimeApiUrl === 'string'
      ? runtimeApiUrl
      : typeof __API_URL__ !== 'undefined'
        ? __API_URL__
        : undefined;
  const authProvider = typeof __AUTH_PROVIDER__ !== 'undefined' ? __AUTH_PROVIDER__ : 'custom';
  const deployEnv = typeof __DEPLOY_ENV__ !== 'undefined' ? __DEPLOY_ENV__ : 'local';
  const flowpadAppHost = typeof __FLOWPAD_APP_HOST__ !== 'undefined' ? __FLOWPAD_APP_HOST__ : 'flowpad.app';
  const flowpadAppPort =
    typeof __FLOWPAD_APP_PORT__ !== 'undefined' && __FLOWPAD_APP_PORT__ ? parseInt(__FLOWPAD_APP_PORT__) : undefined;
  const checkRefreshToken = typeof __CHECK_REFRESH_TOKEN__ !== 'undefined' ? __CHECK_REFRESH_TOKEN__ : false;
  const uiVersion = typeof __UI_VERSION__ !== 'undefined' ? __UI_VERSION__ : '';

  const { api_protocol, api_host, api_port } = parseApiConnectionPrimitives(apiUrl);

  const configData: ISDKConfig = {
    api_protocol,
    api_host,
    api_port,
    deploy_env: deployEnv,
    auth_provider: authProvider,
    flowpad_app_host: flowpadAppHost,
    flowpad_app_port: flowpadAppPort,
    check_refresh_token: checkRefreshToken,
    ui_version: uiVersion,
  };

  return new SDKConfig(configData);
}
