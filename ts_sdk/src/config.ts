import { sdkConfig } from './config/index';

/** Build modes a bundle can be built as. `DESKTOP` is the published wheel (`build_ui.py`),
 *  which every hub serves too — so this is never "which hub", see `isHubOnly()` for that. */
export const deployEnv = ['LOCAL', 'DEVELOPMENT', 'STAGING', 'PRODUCTION', 'DESKTOP'] as const;
export type DeployEnv = (typeof deployEnv)[number];

/** The build's `DEPLOY_ENV`, checked. Throws on a value outside `deployEnv`. */
export function createDeployEnv(value: string): DeployEnv {
  const upper = value.toUpperCase();
  const env = deployEnv.find((e) => e === upper);
  if (!env) throw new Error(`Unknown DEPLOY_ENV '${value}', expected one of: ${deployEnv.join(', ')}`);
  return env;
}

// Use the new configuration system
export const config = {
  SUBPATH: '',
  DEPLOY_ENV: createDeployEnv(sdkConfig.deploy_env),
  AUTH_PROVIDER: sdkConfig.auth_provider,
  SERVER_URL: sdkConfig.serverUrl,
  // HTTP axios base — relative same-origin in local dev (drops CORS preflights),
  // absolute serverUrl when packaged/electron. See SDKConfig.httpBaseUrl.
  httpBaseUrl: sdkConfig.httpBaseUrl,
  WS_URL: sdkConfig.wsUrl,
  FLOWPAD_APP_HOST: sdkConfig.flowpad_app_host,
  FLOWPAD_APP_PORT: sdkConfig.flowpad_app_port,
  API_PREFIXES: sdkConfig.apiPrefixes,
  CHECK_REFRESH_TOKEN: sdkConfig.check_refresh_token,
  PREFILL_MESSAGE_QUERY_PARAM: 'prefill',
  LOGIN_QUERY_PARAM: 'login',
  SIGNUP_QUERY_PARAM: 'signup',
};

export default config;
