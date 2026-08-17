/**
 * react-router root loader — guarantees `initSdk` runs to completion before
 * any React tree mounts.
 *
 * Wired onto the root `<Route path="/" element={<RootLayout/>}>` in
 * `ui/src/router.tsx`. Because the root route's element (and therefore
 * `<App>` and every entity-touching hook it contains) renders only after
 * the root loader's promise resolves, schemas + bootstrap data are
 * registered by the time the first `useEntity` subscription fires.
 *
 * `initSdk` is idempotent (memoised via `initPromise` in `ts_sdk/src/main.ts`),
 * so this is safe even if a stale per-route loader still calls it.
 */

import { dataContext, initSdk, isBackendUnreachable } from '@sdk';
import type { LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { applySupportedLocales } from '@src/contexts/locale-context';

export async function loadRoot(_args: LoaderArgs) {
  await initSdk();

  // Backend is the source of truth for supported locales (bootstrap payload).
  // Install the list + re-resolve the active locale now that it's available
  // (initLocale ran pre-bootstrap against the en-US fallback). Awaited so the
  // catalog/direction are settled before the app tree mounts.
  await applySupportedLocales(dataContext.bootstrapInfo?.supported_locales);

  // Bootstrap may still set a service-unavailable / network / config error
  // on dataContext (initSdk swallows those and signals via navigator.error).
  // Re-throw so the router renders the route's `errorElement` (ErrorScreen)
  // instead of trying to mount the app against a broken backend.
  const bootstrapError = dataContext.bootstrapError as
    | { isServiceUnavailable?: boolean; type?: string; message?: string }
    | null
    | undefined;
  if (isBackendUnreachable(bootstrapError)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw bootstrapError;
  }

  return null;
}
