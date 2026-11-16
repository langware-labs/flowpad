/**
 * What the flowpad UI needs of the Sentry SDK -- and nothing from Sentry itself.
 *
 * This UI is open source and carries no Sentry code. The SDK is built and served by the hub
 * (`ops/sentry-sdk` in the hub repo, route `/api/v1/sentry-sdk/browser`) and loaded at RUNTIME, only
 * when the backend's bootstrap carries a `sentry_info`. These are structural types for that
 * script's global: no `@sentry/*` package is imported anywhere under `src/`.
 *
 * `SDK_CONTRACT` is the version of this surface. The hub's script states which one it implements
 * and the loader refuses any other, so the two repos can change on their own schedules.
 */

export const SDK_CONTRACT = 1;

/** The global the hub's script defines. */
export const SDK_GLOBAL = '__FlowpadSentry';

/**
 * Where the script lives on the hub's origin. FIXED in code, never read from `sentry_info` or any
 * other config: a URL in config would run whatever script it points to.
 */
export const SDK_PATH = '/api/v1/sentry-sdk/browser';

export interface SentryClientLike {
  close(timeout?: number): Promise<boolean>;
  flush(timeout?: number): Promise<boolean>;
}

/** The 8 names the hub's script exposes (`ops/sentry-sdk/entry.ts`). */
export interface SentrySdk {
  contract: number;
  init(options: Record<string, unknown>): unknown;
  getClient(): SentryClientLike | undefined;
  captureException(error: unknown, hint?: { tags?: Record<string, string> }): string;
  globalHandlersIntegration(): unknown;
  linkedErrorsIntegration(options?: { limit?: number }): unknown;
  dedupeIntegration(): unknown;
  eventFiltersIntegration(): unknown;
}

/** The part of an SDK event the sanitizer reads. Everything else is never copied. */
export interface SentryEventLike {
  event_id?: string;
  timestamp?: number;
  level?: string;
  environment?: string;
  release?: string;
  exception?: { values?: Array<Record<string, unknown>> };
  tags?: Record<string, unknown>;
  request?: { url?: string };
  sdk?: { name?: string; version?: string };
  [key: string]: unknown;
}

export interface SentryHintLike {
  originalException?: unknown;
}
