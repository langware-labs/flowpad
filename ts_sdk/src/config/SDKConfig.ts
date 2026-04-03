import { ISDKConfig } from './types';

export class SDKConfig implements ISDKConfig {
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

  constructor(config: ISDKConfig) {
    this.api_protocol = config.api_protocol;
    this.api_host = config.api_host;
    this.api_port = config.api_port;
    this.deploy_env = config.deploy_env;
    this.auth_provider = config.auth_provider;
    this.flowpad_app_host = config.flowpad_app_host;
    this.flowpad_app_port = config.flowpad_app_port;
    this.sentry_dsn = config.sentry_dsn;
    this.sentry_project = config.sentry_project;
    this.check_refresh_token = config.check_refresh_token;
  }

  private needsPortInUrl(): boolean {
    return !(
      (this.api_protocol === 'http' && this.api_port === 80) ||
      (this.api_protocol === 'https' && this.api_port === 443)
    );
  }

  get apiUrl(): string {
    const portSuffix = this.needsPortInUrl() ? `:${this.api_port}` : '';
    return `${this.api_protocol}://${this.api_host}${portSuffix}`;
  }

  get serverUrl(): string {
    return `${this.apiUrl}/api/v1`;
  }

  get wsUrl(): string {
    const wsProtocol = this.api_protocol === 'https' ? 'wss' : 'ws';
    const portSuffix = this.needsPortInUrl() ? `:${this.api_port}` : '';
    return `${wsProtocol}://${this.api_host}${portSuffix}/api/v1/connect/ws`;
  }

  get isDevelopment(): boolean {
    return this.deploy_env.toLowerCase() === 'development';
  }

  get isLocal(): boolean {
    return this.deploy_env.toLowerCase() === 'local';
  }

  get isProduction(): boolean {
    return this.deploy_env.toLowerCase() === 'production';
  }

  // Legacy compatibility properties
  get SERVER_URL(): string {
    return this.serverUrl;
  }

  get API_PREFIXES() {
    return {
      bootstrap: '/graph/bootstrap',
      refreshToken: '/auth/refresh-token',
      graph: '/graph',
      currentUser: '/current-user',
      login: '/login',
      signup: '/signup',
      logout: '/logout',
      connect: '/connect/ws',
      health: '/health/status',
      redirect: '/redirect',
      schema: '/public_schema',
    };
  }

  get apiPrefixes() {
    return this.API_PREFIXES;
  }

  get FLOWPAD_APP_HOST(): string {
    return this.flowpad_app_host;
  }

  get FLOWPAD_APP_PORT(): number | undefined {
    return this.flowpad_app_port;
  }
}
