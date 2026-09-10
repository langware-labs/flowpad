import { lazyAssets } from '../lazy/registry';
import { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { config, dataManager } from '..';
import apiClient, { invalidRefreshTokenMessage, invalidTokenMessage } from '../client';
import { LocalLoginStatus, LoginSlot, makeLoginSlot } from '../services/cloud_status';
import { defineGlobal } from '../utils/globals';

export enum AuthErrorType {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN = 'INVALID_REFRESH_TOKEN',
  INVALID_TOKEN = 'INVALID_TOKEN',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  ACCOUNT_NOT_VERIFIED = 'ACCOUNT_NOT_VERIFIED',
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export enum AuthEventType {
  TOKEN_EXPIRED = 'on_token_expired',
  AUTH_STATUS_CHANGED = 'on_auth_status_changed',
  AUTH_ERROR = 'on_auth_error',
  VISITOR_SUCCESS = 'on_visitor_success',
}

export interface LoginInfo {
  email: string;
  password: string;
  remember_me: boolean;
}

export interface LoginData {
  token: string;
  expires: number;
  user: any;
}

export interface AuthError extends Error {
  type: AuthErrorType;
  statusCode?: number;
  originalError?: any;
}

export interface VisitorInfo {
  [key: string]: any;
}

export interface VisitorData {
  visitor_id: string;
  session_id?: string;
  // Additional visitor data returned from the API
  [key: string]: any;
}

export interface LogoutData {
  success: boolean;
  message?: string;
}

/**
 * Extract all UTM parameters from the current URL.
 * Returns an object with all query params starting with 'utm_'.
 */
export function getUtmParams(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key.startsWith('utm_')) {
      utm[key] = value;
    }
  });
  return utm;
}

/**
 * Marks the session probe's own request, so its 401 is judged by the probe
 * rather than re-entering the interceptor and probing again. A request-config
 * key, not a header: axios carries unknown config keys through to `error.config`
 * and never sends them, where a custom header would add a CORS preflight.
 */
const SESSION_PROBE = '__flowpadSessionProbe';

/**
 * The one machine-readable denial the hub sends (`AuthErrorCode`, mirrored in
 * flow_sdk as `HubErrorCode`): the entity doesn't exist OR the caller holds no
 * role on it. Either way the credential was accepted.
 */
function isTargetNotFound(data: { data?: { error_code?: unknown } | null } | undefined) {
  return data?.data?.error_code === 'target_not_found';
}

export class AuthManager extends EventEmitter {
  _currentUser: any = null;

  // One probe in flight at a time: a page load fans out one status call per
  // shared machine, and every codeless 401 in that burst asks the same question.
  private _sessionProbe: Promise<boolean> | null = null;

  // Local login slot — same vocabulary as the hub side, narrower membership.
  // Mutated only via setLoginStatus(); subscribers listen to
  // AuthEventType.AUTH_STATUS_CHANGED (event payload upgraded to the slot
  // shape; legacy listeners receiving plain user objects still see
  // currentUser via the second emit at the bottom of each transition).
  private _login: LoginSlot<LocalLoginStatus> = makeLoginSlot<LocalLoginStatus>('logged_out');

  get loginStatus(): LocalLoginStatus {
    return this._login.status;
  }

  get loginSlot(): Readonly<LoginSlot<LocalLoginStatus>> {
    return this._login;
  }

  private setLoginStatus(
    status: LocalLoginStatus,
    user: Record<string, unknown> | null = null,
    reason: string | null = null,
  ) {
    const prev = this._login.status;
    this._login = { status, user, reason };
    // Push into the context mirror so mobx observers re-render. Lazy import
    // keeps this module load-order independent.
    void import('./context').then((mod) => mod.dataContext.setLocalLoginStatus?.(status));
    if (prev !== status) {
      this.emit('login_status_changed', this._login);
    }
  }

  constructor() {
    super();
  }

  private extractErrorMessage(error: any, defaultMessage: string): string {
    let errorMessage = error.message || defaultMessage;
    if (error.response?.data) {
      const responseData = error.response.data;
      if (responseData.message) {
        errorMessage = responseData.message;
      } else if (responseData.detail) {
        errorMessage = responseData.detail;
      } else if (responseData.error) {
        errorMessage = responseData.error;
      }
    }
    return errorMessage;
  }
  get isLoggedIn() {
    return this._login.status === 'logged_in' && this._currentUser !== null;
  }
  get currentUser() {
    return this._currentUser;
  }
  set currentUser(user: any) {
    this._currentUser = user;
    const scope = user?.id ?? 'anonymous';
    lazyAssets.setScope(scope);
    dataManager.adoptReadScope(scope);
  }
  /**
   * Whether the server still accepts this session's credential — the question a
   * codeless 401 leaves open. The hub answers "your token is invalid" and "your
   * valid token may not do this" with the same 401, and a policy denial carries
   * no `error_code`, so ask it directly instead of reading its prose: the check
   * flow_sdk makes in `hub_email_inbox_driver._hub_login_is_valid`.
   */
  private sessionStillValid(): Promise<boolean> {
    if (!this._sessionProbe) {
      this._sessionProbe = apiClient
        .get(config.API_PREFIXES.currentUser, { [SESSION_PROBE]: true } as AxiosRequestConfig)
        .then(
          (user) => !!user,
          () => false,
        )
        .finally(() => {
          this._sessionProbe = null;
        });
    }
    return this._sessionProbe;
  }
  private async setupClientInterceptor() {
    apiClient.interceptors.response.use(
      function (response: AxiosResponse) {
        return response;
      },
      async (error: AxiosError) => {
        // Skip auth handling for 404s - these are normal "not found" responses
        if (error.response?.status === 404) {
          return Promise.reject(error);
        }
        // The session probe's own failure is its answer, not a new question.
        if ((error.config as Record<string, unknown> | undefined)?.[SESSION_PROBE]) {
          return Promise.reject(error);
        }

        // AUTHENTICATION failures only — "this session's token is no longer
        // usable". An AUTHORIZATION answer ("your valid token may not do this
        // one thing") must NOT end the session: `ops` on a compute_node resolves
        // for `owner` alone, so a machine shared with you refuses its status
        // probe on every page load, and treating that as expiry logged the whole
        // account out (FLOWPAD-2125). Those reject to the caller, which decides
        // what to render. A 403 is never an expired token; a codeless 401 is
        // settled by asking whether the credential still works.
        // For server errors (5xx) and other non-auth errors, pass through silently
        const data = error.response?.data as any;
        const isAuthError =
          data?.message === invalidRefreshTokenMessage ||
          error.message === invalidTokenMessage ||
          (error.response?.status === 401 && !isTargetNotFound(data) && !(await this.sessionStillValid()));

        if (isAuthError) {
          this.currentUser = null;
          this.setLoginStatus('logged_out', null, 'expired');
          const authError: AuthError = new Error('Invalid refresh token') as AuthError;
          if ((error.response?.data as any)?.message === invalidRefreshTokenMessage) {
            authError.type = AuthErrorType.INVALID_REFRESH_TOKEN;
            this.emit(AuthEventType.AUTH_ERROR, authError);
          } else if (error.message === invalidTokenMessage) {
            authError.type = AuthErrorType.INVALID_TOKEN;
            this.emit(AuthEventType.AUTH_ERROR, error);
          }
          console.error('Response Error', error);
        }

        return Promise.reject(error);
      },
    );
  }
  public async init(user?: any) {
    await this.setupClientInterceptor();
    let currentUser = user;
    try {
      if (user === undefined) {
        currentUser = await dataManager.getCurrentUser();
      }
      if (!currentUser) {
        const authError: AuthError = new Error('Authentication failed - no user found') as AuthError;
        authError.type = AuthErrorType.INVALID_CREDENTIALS;
        this.setLoginStatus('logged_out');
        this.emit(AuthEventType.AUTH_ERROR, authError);
      }
      this.currentUser = currentUser;
      if (currentUser) this.setLoginStatus('logged_in', currentUser as Record<string, unknown>);
      this.emit(AuthEventType.AUTH_STATUS_CHANGED, currentUser);
    } catch (error) {
      const authError: AuthError = error as AuthError;
      authError.type = AuthErrorType.INVALID_CREDENTIALS;
      this.emit(AuthEventType.AUTH_ERROR, authError);
    }
  }

  public async login(login: LoginInfo): Promise<LoginData> {
    this.setLoginStatus('logging_in');
    try {
      const loginData: LoginData = await apiClient.post(`${config.API_PREFIXES.login}`, login);
      if (!loginData) {
        const authError: AuthError = new Error('No data found on login') as AuthError;
        authError.type = AuthErrorType.SERVER_ERROR;
        console.error('Login failed: No data found on login', authError);
        throw authError;
      }

      this.currentUser = loginData.user;
      this.setLoginStatus('logged_in', loginData.user as Record<string, unknown>);
      this.emit(AuthEventType.AUTH_STATUS_CHANGED, loginData.user);

      return loginData;
    } catch (error: any) {
      const errorMessage = this.extractErrorMessage(error, 'Login failed');
      const authError: AuthError = new Error(errorMessage) as AuthError;
      authError.originalError = error;
      authError.statusCode = error.response?.status;

      if (error.response?.status === 401) {
        authError.type = AuthErrorType.INVALID_CREDENTIALS;
      } else if (error.response?.status === 423) {
        authError.type = AuthErrorType.ACCOUNT_LOCKED;
      } else if (error.response?.status === 403) {
        authError.type = AuthErrorType.ACCOUNT_NOT_VERIFIED;
      } else if (error.response?.status === 429) {
        authError.type = AuthErrorType.TOO_MANY_ATTEMPTS;
      } else if (error.response?.status >= 500) {
        authError.type = AuthErrorType.SERVER_ERROR;
      } else if (!error.response) {
        authError.type = AuthErrorType.NETWORK_ERROR;
      } else {
        authError.type = AuthErrorType.UNKNOWN_ERROR;
      }

      this.setLoginStatus('login_failed', null, authError.type);
      this.emit(AuthEventType.AUTH_ERROR, authError);

      throw authError;
    }
  }

  public async logout(): Promise<LogoutData> {
    try {
      const logoutData: LogoutData = await apiClient.post(`${config.API_PREFIXES.logout}`, {});

      this.currentUser = null;
      this.setLoginStatus('logged_out');
      this.emit(AuthEventType.AUTH_STATUS_CHANGED, null);

      return logoutData;
    } catch (error: any) {
      const errorMessage = this.extractErrorMessage(error, 'Logout failed');
      const authError: AuthError = new Error(errorMessage) as AuthError;
      authError.originalError = error;
      authError.statusCode = error.response?.status;
      authError.type =
        error.response?.status >= 500
          ? AuthErrorType.SERVER_ERROR
          : !error.response
            ? AuthErrorType.NETWORK_ERROR
            : AuthErrorType.UNKNOWN_ERROR;

      this.emit(AuthEventType.AUTH_ERROR, authError);

      throw authError;
    }
  }

  public async visit(visitor: VisitorInfo): Promise<VisitorData> {
    try {
      const params = new URLSearchParams();
      if (visitor.session) {
        params.set('session', 'true');
      }
      // Add UTM params from current URL
      const utmParams = getUtmParams();
      Object.entries(utmParams).forEach(([key, value]) => {
        params.set(key, value);
      });
      const queryString = params.toString();
      // Typed as the two shapes the line below actually reads: the id itself,
      // or a `{data}` wrapper. `/visit` is a hub-side route (no local backend
      // handler), so the wrapper branch is kept rather than narrowed away.
      const response = await apiClient.get<string | { data?: string }>(
        `/visit${queryString ? '?' + queryString : ''}`,
      );

      const visitorId = typeof response === 'string' ? response : response.data;

      if (!visitorId) {
        const authError: AuthError = new Error('No data found on visitor registration') as AuthError;
        authError.type = AuthErrorType.SERVER_ERROR;
        throw authError;
      }

      const visitorData: VisitorData = { visitor_id: visitorId };
      this.emit(AuthEventType.VISITOR_SUCCESS, visitorData);

      return visitorData;
    } catch (error: any) {
      const errorMessage = this.extractErrorMessage(error, 'Visitor registration failed');
      const authError: AuthError = new Error(errorMessage) as AuthError;
      authError.originalError = error;
      authError.statusCode = error.response?.status;

      if (error.response?.status === 429) {
        authError.type = AuthErrorType.TOO_MANY_ATTEMPTS;
      } else if (error.response?.status >= 500) {
        authError.type = AuthErrorType.SERVER_ERROR;
      } else if (!error.response) {
        authError.type = AuthErrorType.NETWORK_ERROR;
      } else {
        authError.type = AuthErrorType.UNKNOWN_ERROR;
      }

      throw authError;
    }
  }

  public async refreshToken(): Promise<string | null> {
    try {
      const refreshTokenDataResponse: string = await apiClient.post(`${config.API_PREFIXES.refreshToken}`, {});
      return refreshTokenDataResponse;
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || 'Refresh token failed';
      console.warn('refreshTokenDataResponse', errorMessage);
      return null;
    }
  }
}

export const authManager = new AuthManager();

// Define auth as a global for console debugability
defineGlobal('auth', authManager);
