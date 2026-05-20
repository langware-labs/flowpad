import { sdkConfig } from './config/index';

export type DeployEnv = 'LOCAL' | 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

// Use the new configuration system
export const config = {
  SUBPATH: '',
  DEPLOY_ENV: sdkConfig.deploy_env.toUpperCase() as DeployEnv,
  SENTRY_DSN: sdkConfig.sentry_dsn,
  SENTRY_PROJECT: sdkConfig.sentry_project,
  AUTH_PROVIDER: sdkConfig.auth_provider,
  SERVER_URL: sdkConfig.serverUrl,
  WS_URL: sdkConfig.wsUrl,
  FLOWPAD_APP_HOST: sdkConfig.flowpad_app_host,
  FLOWPAD_APP_PORT: sdkConfig.flowpad_app_port,
  API_PREFIXES: sdkConfig.apiPrefixes,
  CHECK_REFRESH_TOKEN: sdkConfig.check_refresh_token,
  PREFILL_MESSAGE_QUERY_PARAM: 'prefill',
  LOGIN_QUERY_PARAM: 'login',
  SIGNUP_QUERY_PARAM: 'signup',
};

export const DEFAULT_MICRO_APP_ID = 'ff69b3dc-9b91-4283-8a09-e9467514bc3d';

export default config;
