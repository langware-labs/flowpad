export interface ISDKConfig {
  api_protocol: string;
  api_host: string;
  api_port: number;
  deploy_env: string;
  auth_provider: string;
  flowpad_app_host: string;
  flowpad_app_port?: number;
  check_refresh_token: boolean;
  /** flow_sdk release this bundle was built from; '' when unresolvable. */
  ui_version: string;
}
