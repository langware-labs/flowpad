import { AxiosError, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { config, dataManager } from '..';
import apiClient, { invalidRefreshTokenMessage, invalidTokenMessage } from '../client';
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

export class AuthManager extends EventEmitter {
  _currentUser: any = null;

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
    return this._currentUser !== null;
  }
  get currentUser() {
    return this._currentUser;
  }
  set currentUser(user: any) {
    this._currentUser = user;
  }
  private async setupClientInterceptor() {
    apiClient.interceptors.response.use(
      function (response: AxiosResponse) {
        return response;
      },
      (error: AxiosError) => {
        // Skip auth handling for 404s - these are normal "not found" responses
        if (error.response?.status === 404) {
          return Promise.reject(error);
        }

        // Only handle auth-related errors (401, 403, token errors)
        // For server errors (5xx) and other non-auth errors, pass through silently
        const isAuthError =
          error.response?.status === 401 ||
          error.response?.status === 403 ||
          (error.response?.data as any)?.message === invalidRefreshTokenMessage ||
          error.message === invalidTokenMessage;

        if (isAuthError) {
          this.currentUser = null;
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
        this.emit(AuthEventType.AUTH_ERROR, authError);
      }
      this.currentUser = currentUser;
      this.emit(AuthEventType.AUTH_STATUS_CHANGED, currentUser);
    } catch (error) {
      const authError: AuthError = error as AuthError;
      authError.type = AuthErrorType.INVALID_CREDENTIALS;
      this.emit(AuthEventType.AUTH_ERROR, authError);
    }
  }

  public async login(login: LoginInfo): Promise<LoginData> {
    try {
      const loginData: LoginData = await apiClient.post(`${config.API_PREFIXES.login}`, login);
      if (!loginData) {
        const authError: AuthError = new Error('No data found on login') as AuthError;
        authError.type = AuthErrorType.SERVER_ERROR;
        console.error('Login failed: No data found on login', authError);
        throw authError;
      }

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

      this.emit(AuthEventType.AUTH_ERROR, authError);

      throw authError;
    }
  }

  public async logout(): Promise<LogoutData> {
    try {
      const logoutData: LogoutData = await apiClient.post(`${config.API_PREFIXES.logout}`, {});

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
      const response = await apiClient.get(`/visit${queryString ? '?' + queryString : ''}`);

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
