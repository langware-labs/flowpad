export interface ISDKConfig {
  api_protocol: string;
  api_host: string;
  api_port: number;
  deploy_env: string;
  auth_provider: string;
  flowpad_app_host: string;
  flowpad_app_port?: number;
  sentry_dsn: string;
  sentry_project: string;
  check_refresh_token: boolean;
}
