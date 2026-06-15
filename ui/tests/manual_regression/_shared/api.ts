/**
 * Backend access for manual-regression tests — never hardcode a port.
 *
 * Default routing is the FRONTEND origin (VITE_PORT): the Vite dev server
 * proxies `/api/*` to whatever backend the app itself is wired to, so the
 * test's API calls and the UI under test can never split across backends
 * (the historical hardcoded :6002/:6003 fallbacks silently queried another
 * instance's DB). QA_API_URL / API_URL override with an explicit backend
 * origin when a test must target a specific instance.
 */
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/** Explicit override, or the frontend origin (whose /api proxies to the right backend). */
export function apiOrigin(): string {
  return (
    process.env.QA_API_URL ||
    process.env.API_URL ||
    `http://localhost:${process.env.VITE_PORT || '4097'}`
  );
}

/**
 * Prefix for fixture-`request` calls and in-page `fetch`: empty string means
 * relative `/api/...` URLs, resolved against the config baseURL / page origin
 * and proxied by Vite to the app's own backend.
 */
export function apiBase(): string {
  return process.env.QA_API_URL || process.env.API_URL || '';
}

/** Node-side APIRequestContext bound to the right backend (see apiOrigin). */
export function apiContext(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: apiOrigin() });
}
