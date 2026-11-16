/**
 * The ONLY entry into `@sentry/browser`, loaded lazily by `./sentry.ts`. Named re-exports let the
 * bundler drop what we never use (replay, feedback, tracing); importing the package namespace
 * directly pulled all of it into the chunk.
 */
export {
  captureException,
  dedupeIntegration,
  eventFiltersIntegration,
  getClient,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
} from '@sentry/browser';
