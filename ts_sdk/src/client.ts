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
 * Where a paged list answer says the next page starts — `has_more` / `next_offset` / `next_cursor` beside
 * `data`. `next_cursor` (sent back as `filter.after`) continues right after the page's last row; it is
 * null on the last page, or when that row has no value for a sort field — then page by `next_offset`.
 */
export interface ListPage {
  has_more: boolean;
  next_offset: number;
  next_cursor?: string | null;
}

/**
 * The unwrap keeps a paged answer's `has_more` / `next_offset` / `next_cursor` on the list it returns — as
 * non-enumerable properties, so the rows still spread, map and serialize as a plain array. An unpaged
 * answer has no `has_more`, and its list gets nothing.
 */
export function withPage<T>(data: T, envelope: unknown): T {
  const meta = envelope as Partial<ListPage> | null | undefined;
  if (!Array.isArray(data) || typeof meta?.has_more !== 'boolean') return data;
  Object.defineProperty(data, 'has_more', { value: meta.has_more, enumerable: false, configurable: true });
  Object.defineProperty(data, 'next_offset', { value: meta.next_offset, enumerable: false, configurable: true });
  Object.defineProperty(data, 'next_cursor', {
    value: meta.next_cursor ?? null,
    enumerable: false,
    configurable: true,
  });
  return data;
}

/** The page a list answer carried, or undefined for an unpaged one. */
export function pageOf(rows: unknown): ListPage | undefined {
  const meta = rows as Partial<ListPage> | null | undefined;
  if (!Array.isArray(rows) || typeof meta?.has_more !== 'boolean') return undefined;
  return {
    has_more: meta.has_more,
    next_offset: Number(meta.next_offset ?? rows.length),
    next_cursor: typeof meta.next_cursor === 'string' && meta.next_cursor ? meta.next_cursor : null,
  };
}

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
export interface ApiAxiosInstance extends Omit<
  AxiosInstance,
  'request' | 'get' | 'delete' | 'head' | 'options' | 'post' | 'put' | 'patch'
> {
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

/**
 * A hub-launched sandbox pauses on E2B's idle timer and auto-resumes on the
 * next request — but the resume is not instant. A request that lands in that
 * window gets a 502 straight from E2B's edge (never reaches our own backend,
 * whose own 5xx codes are never 502), with the body "the sandbox is running
 * but port is not open". Nothing before this retried it, so a login (or
 * anything else) that happened to land in that window just failed outright,
 * with no signal to the caller that trying again a moment later would work.
 *
 * Bounded and short on purpose: this is a race measured in hundreds of
 * milliseconds, not a circuit breaker for a genuinely down backend — that
 * case is `isServiceUnavailable` below, which this leaves untouched.
 */
const SANDBOX_WAKING_RETRY_STATUS = 502;
const SANDBOX_WAKING_RETRY_DELAYS_MS = [300, 800];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

      // Who is asking — the screen this call came from — so a hub error it causes says "Made by".
      if (typeof window !== 'undefined' && !request.headers?.['X-Flow-Caller']) {
        request.headers = request.headers || {};
        request.headers['X-Flow-Caller'] = window.location.pathname.slice(0, 200);
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
      // A caller that reads the warnings itself (`DataManager.callActionWithWarnings`) gets the envelope.
      if ((response.config as { keepEnvelope?: boolean } | undefined)?.keepEnvelope) return response.data;
      return withPage(response.data.data, response.data);
    },
    (error) => {
      // Any status codes that falls outside the range of 2xx cause this function to trigger
      // Do something with response error
      const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementFailed(method);
      rememberFailedCall(error);

      // A sandbox waking from E2B's idle pause: retry silently, a few times,
      // with a short delay — see SANDBOX_WAKING_RETRY_STATUS above.
      if (error.response?.status === SANDBOX_WAKING_RETRY_STATUS && error.config) {
        const cfg = error.config as AxiosRequestConfig & { __sandboxWakeRetryCount?: number };
        const attempt = cfg.__sandboxWakeRetryCount ?? 0;
        if (attempt < SANDBOX_WAKING_RETRY_DELAYS_MS.length) {
          cfg.__sandboxWakeRetryCount = attempt + 1;
          const delay = SANDBOX_WAKING_RETRY_DELAYS_MS[attempt];
          console.log(`API call got 502 (sandbox likely waking up) — retrying in ${delay}ms`);
          return sleep(delay).then(() => client.request(cfg));
        }
      }

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

/** A failed backend call, described once when it fails — the request and the backend's answer. */
export interface FailedCallDetail {
  request: { method?: string; url?: string; caller?: string };
  response: { status?: number; message?: string; body?: string; errorCode?: string; requestId?: string };
}

const MAX_BODY_CHARS = 4096;

interface AxiosLikeError {
  isAxiosError?: boolean;
  config?: { method?: string; url?: string; headers?: Record<string, unknown> };
  response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
  message?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The backend's own reason: the envelope `message`, or FastAPI's `detail` (a string or a list of problems). */
function answerOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return str(data);
  const d = data as { message?: unknown; detail?: unknown };
  if (Array.isArray(d.detail))
    return d.detail.map((x: { msg?: unknown }) => str(x?.msg) ?? JSON.stringify(x)).join('; ');
  return str(d.detail) ?? str(d.message);
}

/** `FailedCallDetail` for an axios error, or undefined for anything else. */
export function describeFailedCall(error: unknown): FailedCallDetail | undefined {
  const e = error as AxiosLikeError | null;
  if (!e || typeof e !== 'object' || !(e.isAxiosError || e.config)) return undefined;
  const data = e.response?.data;
  const body =
    data === undefined || data === null ? undefined : typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const headers = e.response?.headers ?? {};
  return {
    request: {
      method: e.config?.method?.toUpperCase(),
      url: e.config?.url,
      caller: str(e.config?.headers?.['X-Flow-Caller']),
    },
    response: {
      status: e.response?.status,
      message: answerOf(data),
      body: body && body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : (body ?? e.message),
      errorCode: str((data as { data?: { error_code?: unknown } } | undefined)?.data?.error_code),
      requestId: str(headers['x-flow-request-id']) ?? str(headers['x-request-id']),
    },
  };
}

/**
 * The last few failed backend calls, newest first, already described (the axios error itself is
 * not kept). An alert raised from a caught error that was not handed to `notify` (it shows only
 * "Request failed with status code 409") is matched back to its call here.
 */
export interface FailedCall {
  at: number;
  /** axios's own message ("Request failed with status code 409"). */
  message: string;
  detail: FailedCallDetail;
}

const MAX_FAILED_CALLS = 20;
export const recentFailedCalls: FailedCall[] = [];

function rememberFailedCall(error: unknown): void {
  const detail = describeFailedCall(error);
  if (!detail) return;
  recentFailedCalls.unshift({ at: Date.now(), message: (error as Error).message ?? '', detail });
  recentFailedCalls.length = Math.min(recentFailedCalls.length, MAX_FAILED_CALLS);
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
    baseURL: conf.httpBaseUrl,
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

/**
 * GET a route that answers with a BARE body instead of the `{status,data}`
 * envelope — a hub route, or anything else we do not own.
 *
 * The response interceptor unwraps `data.data`, so such a body arrives as
 * `undefined` unless it is wrapped first. Callers were each spelling the same
 * `transformResponse` to do that; it belongs here, next to the interceptor
 * that makes it necessary. A route we DO own should return the envelope
 * instead of being read through this.
 */
export async function getRaw<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
  return apiClient.get<T>(path, {
    ...config,
    transformResponse: (raw: string) => ({ data: raw ? JSON.parse(raw) : null }),
  }) as unknown as Promise<T>;
}

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
/**
 * Does this error MESSAGE describe the browser tearing a request down?
 *
 * A navigation kills an in-flight `fetch` with a bare `TypeError` whose wording is
 * the only signal the platform gives, and it differs per engine — Chrome
 * "Failed to fetch", Firefox "NetworkError"/"network error", Safari "Load failed".
 * Shared so the axios-side outage check below and the raw-`fetch` streaming path
 * (`AgenticProcess.prompt`) classify off ONE string set instead of drifting apart.
 */
export function isNetworkErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('network error') ||
    m.includes('load failed')
  );
}

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
    isNetworkErrorMessage(e.message),
  );
}
