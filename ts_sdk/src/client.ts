import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { ApiFailResponse, ApiWarning } from './ApiResponse';
import { alert } from './alert';
import { APIStats } from './apiStats';
import config from './config';
import { API_PREFIX } from './config/SDKConfig';

//@ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function generateCurlCommand(request: AxiosRequestConfig) {
  // eslint-disable-next-line prefer-const
  let { method, url, data, headers } = request;
  if (!method) {
    method = 'GET'; // Default to 'GET' if no method is specified
  } else {
    method = method.toUpperCase();
  }
  let curlCmd = `curl -X ${method} "${config.SERVER_URL}${url}"`;

  // Include headers, if any
  if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      curlCmd += ` -H "${key}: ${value}"`;
    });
  }

  // Include request body data, if any. Assuming JSON format here.
  if (data) {
    if (typeof data === 'object') {
      // If data is an object, stringify it
      data = JSON.stringify(data);
    }
    curlCmd += ` --data-raw '${data}'`;
  }

  return curlCmd;
}

export const GRAPH_API_PREFIX = config.API_PREFIXES.graph;

export const CURRENT_USER = config.API_PREFIXES.currentUser;

export const apiStats = new APIStats();

export function clearStats() {
  apiStats.reset();
}

export type ExecutionContext = 'browser' | 'node';

/**
 * Axios, retyped to say what this client ACTUALLY returns.
 *
 * `initApiClient`'s response interceptor returns `response.data.data` — it
 * unwraps the backend's `{status, data}` envelope, which is the whole reason
 * CLAUDE.md points non-entity REST calls at `apiClient` instead of `fetch`.
 * Axios's own types cannot express that: they still promise
 * `AxiosResponse<T>`, so every `apiClient.get<T>(…)` in the tree was typed as
 * the envelope while holding the payload. Callers wrote the correct runtime
 * code (`const rows = await apiClient.get<Row[]>(…); rows.map(…)`) and the
 * compiler called it an error.
 */
export interface ApiAxiosInstance
  extends Omit<AxiosInstance, 'request' | 'get' | 'delete' | 'head' | 'options' | 'post' | 'put' | 'patch'> {
  request<T = unknown, D = unknown>(config: AxiosRequestConfig<D>): Promise<T>;
  get<T = unknown, D = unknown>(url: string, config?: AxiosRequestConfig<D>): Promise<T>;
  delete<T = unknown, D = unknown>(url: string, config?: AxiosRequestConfig<D>): Promise<T>;
  head<T = unknown, D = unknown>(url: string, config?: AxiosRequestConfig<D>): Promise<T>;
  options<T = unknown, D = unknown>(url: string, config?: AxiosRequestConfig<D>): Promise<T>;
  post<T = unknown, D = unknown>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<T>;
  put<T = unknown, D = unknown>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<T>;
  patch<T = unknown, D = unknown>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<T>;
}

export const invalidTokenMessage = 'Invalid token, login required';
export const invalidRefreshTokenMessage = 'Invalid refresh token, login required';

// Extended client interface for test token support
interface ExtendedApiClient extends ApiAxiosInstance {
  testUserToken?: string;
}

/** Keep one API prefix when a canonical path meets a prefix-bearing baseURL. */
export function normalizeApiPathForBase(baseUrl: string | undefined, path: string | undefined): string | undefined {
  const base = baseUrl?.replace(/\/+$/, '') ?? '';
  if (base.endsWith(API_PREFIX) && path?.startsWith(`${API_PREFIX}/`)) {
    return path.slice(API_PREFIX.length);
  }
  return path;
}

function initApiClient(client: ApiAxiosInstance) {
  client.interceptors.request.use(
    function (request) {
      // `SDKConfig.serverUrl` already ends in /api/v1. Public SDK managers use
      // canonical API paths (`/api/v1/...`), while older callers still pass
      // prefix-relative paths (`/graph/...`). Normalize only the former at the
      // Axios boundary so both resolve to exactly one /api/v1 segment.
      request.url = normalizeApiPathForBase(request.baseURL, request.url);
      apiStats.incrementTotal();
      const method = request.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementInFlight(method);

      // Add Authorization header for test user token if set (for API tests in jsdom environment)
      // This ensures reliable test authentication while keeping cookies for browser operations
      const extendedClient = client as ExtendedApiClient;
      if (extendedClient.testUserToken && !request.headers?.['Authorization']) {
        request.headers = request.headers || {};
        request.headers['Authorization'] = `Bearer ${extendedClient.testUserToken}`;
      }

      return request;
    },
    function (error) {
      const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementFailed(method);
      // Do something with request error
      return Promise.reject(error as Error);
    },
  );

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const method = response.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementSuccessful(method);
      // The interceptor unwraps to `data`, so anything else on the envelope is
      // dropped here. `warnings` is a SUCCESS response saying part of the work
      // did not land (e.g. a record saved to disk whose DB row failed) — the
      // caller got its payload and would otherwise never learn that, so log it
      // rather than let it vanish between the server and the app.
      const warnings = (response.data as { warnings?: ApiWarning[] })?.warnings;
      if (warnings?.length) {
        console.warn(
          `[api] ${method} ${response.config?.url ?? ''} succeeded with warnings:`,
          warnings.map((w) => `${w.error_code}: ${w.message}`).join('; '),
        );
      }
      return response.data.data;
    },
    (error) => {
      // Any status codes that falls outside the range of 2xx cause this function to trigger
      // Do something with response error
      const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementFailed(method);

      // Check for network errors (backend unavailable)
      if (error.code === 'ERR_NETWORK' || error.code === 'ERR_CONNECTION_REFUSED' || !error.response) {
        console.log('API call error: Service Unavailable - Backend server is not responding');
        // Add a custom flag to identify service unavailable errors
        error.isServiceUnavailable = true;
        error.status = 503; // Service Unavailable HTTP status code
        throw error;
      }

      const msg = error.response?.data?.detail || error.response?.data?.message || error.message;
      if (error.response?.status === 422) {
        throw error;
      }
      // Don't log 404s - callers handle "not found" gracefully
      if (error.response?.status !== 404) {
        console.log('API call error:', msg);
      }
      if (error.response?.status === 401) {
        alert(error.response.statusText, msg, 'warning');
      }
      throw error;
      //return Promise.reject(error);
    },
  );
}

export function getApiClient(): ApiAxiosInstance {
  const conf = config;
  // The one honest cast in this file: `axios.create` hands back a plain
  // AxiosInstance, and `initApiClient` below is what converts it into an
  // ApiAxiosInstance by installing the unwrapping interceptor. The conversion
  // is a runtime fact no signature can carry, so it is asserted here, once, at
  // the seam — not at the hundreds of call sites downstream.
  const client = axios.create({
    headers: { Accept: 'application/json' },
    baseURL: conf.SERVER_URL,
    withCredentials: true,
    validateStatus: (status) => {
      return (status >= 200 && status < 300) || status == 302 || status == 307; // Custom validation: allow 2xx and 3xx
    },
  });
  initApiClient(client);
  return client as unknown as ApiAxiosInstance;
}

export function getErrorMessages(error: AxiosError): string {
  // Axios error handling
  if (error.response) {
    // Server response was received but indicates an error
    console.error('Error status:', error.response.status, 'data: ', error.response.data);
    if (error.response.data) {
      const response = error.response.data as ApiFailResponse<string>;
      if (response.status === 'FAIL') return response.message;
      else return response.message || error.message;
    }
  } else if (error.request) {
    // Request was made but no response was received
    console.error('No response received for the request.');
    return '';
  } else {
    // An error occurred in setting up the request
    console.error('Error message:', error.message);
    return '';
  }
  return '';
}

export const apiClient = getApiClient(); // Initialize the default API client

export default apiClient;

// For playwright client global variable
//@ts-ignore
window['client'] = apiClient;

/**
 * Is this error "the backend is unreachable", as opposed to "one request
 * failed"? The axios interceptor below is the classifier — it stamps
 * `isServiceUnavailable` exactly when there is no response at all — and this is
 * the one place that answers the question for every consumer.
 *
 * It used to be re-spelled at four call sites (both outage screens and both
 * route loaders) with four different clause sets, which is how one of them came
 * to treat ANY 5xx as an outage and blank the app over a single unsupported
 * action. A 5xx is emphatically not an outage. `type: 'network' | 'config'`
 * covers errors minted by `navigationService.error()`, which never pass through
 * the interceptor.
 */
export function isBackendUnreachable(error: unknown): boolean {
  const e = error as
    | { isServiceUnavailable?: boolean; type?: string; code?: string; message?: string }
    | null
    | undefined;
  if (!e) return false;
  return Boolean(
    e.isServiceUnavailable ||
    e.type === 'network' ||
    e.type === 'config' ||
    e.code === 'ERR_NETWORK' ||
    e.code === 'ERR_CONNECTION_REFUSED' ||
    e.message?.includes('Failed to fetch') ||
    e.message?.includes('Network request failed'),
  );
}
