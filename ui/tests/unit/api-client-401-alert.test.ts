/**
 * The SDK client's 401 alert.
 *
 * A 401 normally means the session is gone, so the client shows a blocking alert.
 *
 * The alert is observed where it lands — the `alert` event `@sdk/alert` dispatches on `window` —
 * rather than by mocking the module, so this exercises the real path.
 */
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getApiClient } from '@sdk/client';

/** The interceptor's error handler rethrows synchronously; axios wraps it into the rejection. */
type ErrorHandler = (error: unknown) => never;

/** The client's own response-error handler — the first one `initApiClient` installs. */
function clientErrorHandler(): ErrorHandler {
  const client = getApiClient();
  const handlers = (client.interceptors.response as unknown as { handlers: { rejected: ErrorHandler }[] }).handlers;
  return handlers[0].rejected;
}

function unauthorized(config: Partial<InternalAxiosRequestConfig> = {}): AxiosError {
  const error = new AxiosError('Request refused');
  error.config = { method: 'get', headers: {}, ...config } as InternalAxiosRequestConfig;
  error.response = {
    status: 401,
    statusText: 'Unauthorized',
    data: { message: 'Forbidden access' },
  } as never;
  return error;
}

/** What the handler threw — it must be the caller's own error, never swallowed. */
function thrownBy(handler: ErrorHandler, error: AxiosError): unknown {
  try {
    handler(error);
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

let alerts: Event[] = [];
const onAlert = (event: Event) => alerts.push(event);

beforeEach(() => {
  alerts = [];
  window.addEventListener('alert', onAlert);
});

afterEach(() => {
  window.removeEventListener('alert', onAlert);
});

describe('apiClient 401 handling', () => {
  it('alerts on an ordinary 401', () => {
    const error = unauthorized();

    expect(thrownBy(clientErrorHandler(), error)).toBe(error);

    expect(alerts).toHaveLength(1);
  });
});
