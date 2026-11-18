/**
 * The REAL Sentry SDK behind the surface the hub's script exposes (hub repo: `ops/sentry-sdk/entry.ts`).
 * Test-only: `@sentry/browser` is a devDependency for exactly this, and nothing under `src/` imports it,
 * so it is never part of the UI bundle. Tests hand it to the loader seam in place of the hub's script.
 */
import {
  captureException,
  dedupeIntegration,
  eventFiltersIntegration,
  getClient,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
} from '@sentry/browser';
import type { SentrySdk } from '@src/telemetry/sentry-contract';

export const realSdk = {
  contract: 1,
  captureException,
  dedupeIntegration,
  eventFiltersIntegration,
  getClient,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
} as unknown as SentrySdk;
