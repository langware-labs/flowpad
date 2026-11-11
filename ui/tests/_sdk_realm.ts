/**
 * Lifecycle owner for test-only SDK realms bound to disposable backends.
 *
 * `vi.resetModules()` gives the caller fresh SDK singletons, but the runtime
 * API override lives on the Vitest worker's shared `globalThis`.  The override
 * must therefore exist only while the SDK config module is evaluated.  The
 * returned handle owns the fresh realm's ConnectionManager and must be
 * disposed when that realm is discarded.
 */
import { vi } from 'vitest';

type SdkRealm = typeof import('@sdk');
type SdkMain = typeof import('@sdk/main');

export interface OwnedSdkRealm {
  sdk: SdkRealm;
  /** Refuse new fire-and-forget scan-info refreshes and wait for those in flight. */
  settle: () => Promise<void>;
  dispose: () => void;
}

export interface OwnedSdkMainRealm extends OwnedSdkRealm {
  main: SdkMain;
}

const ownedRealms = new Set<OwnedSdkRealm>();

async function loadOwnedRealm(apiUrl: string, includeMain: boolean): Promise<OwnedSdkMainRealm> {
  const globals = globalThis as Record<string, unknown>;
  const key = '__FLOWPAD_API_URL__';
  const hadPrevious = Object.prototype.hasOwnProperty.call(globals, key);
  const previous = globals[key];

  globals[key] = apiUrl;
  try {
    vi.resetModules();
    const sdk = await import('@sdk');
    const main = includeMain ? await import('@sdk/main') : (undefined as unknown as SdkMain);
    let disposed = false;
    // The SDK fires `dataManager.refreshScanInfo()` without awaiting it (after
    // indexType / clear-index, and from a progress `complete` event's timer).
    // Its body does `await import('../lazy')`; run after this realm's graph is evicted, that
    // import evaluates a second SDK copy into a dead graph and breaks the next
    // file. So the realm tracks its refreshes, and refuses new ones once closing.
    let closing = false;
    const scanRefreshes = new Set<Promise<void>>();
    const refreshScanInfo = sdk.dataManager.refreshScanInfo.bind(sdk.dataManager);
    sdk.dataManager.refreshScanInfo = () => {
      if (closing) return Promise.resolve();
      const refresh = refreshScanInfo().finally(() => scanRefreshes.delete(refresh));
      scanRefreshes.add(refresh);
      return refresh;
    };
    const realm: OwnedSdkMainRealm = {
      sdk,
      main,
      settle: async () => {
        closing = true;
        await Promise.allSettled([...scanRefreshes]);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        closing = true;
        sdk.connectionManager.dispose();
        sdk.lazyAssets.setScope('disposed');
        sdk.queryClient.clear();
        ownedRealms.delete(realm);
        // `vi.resetModules()` is worker-global, so retain the graph while any
        // sibling owned realm is still live. Once the final realm is gone,
        // evict the disposable graph so later imports cannot resolve modules
        // configured for a now-killed backend.
        if (ownedRealms.size === 0) vi.resetModules();
      },
    };
    ownedRealms.add(realm);
    return realm;
  } finally {
    if (hadPrevious) globals[key] = previous;
    else delete globals[key];
  }
}

/** Import a fresh SDK realm while scoping the runtime URL override to import. */
export async function createSdkRealm(apiUrl: string): Promise<OwnedSdkRealm> {
  return loadOwnedRealm(apiUrl, false);
}

/** Import a fresh SDK + main-entry realm while sharing one module graph. */
export async function createSdkMainRealm(apiUrl: string): Promise<OwnedSdkMainRealm> {
  return loadOwnedRealm(apiUrl, true);
}

/** Settle every owned realm's in-flight SDK work; await it before disposing. */
export async function settleOwnedSdkRealms(): Promise<void> {
  await Promise.all([...ownedRealms].map((realm) => realm.settle()));
}

/** Dispose every realm created through this helper in the current test file. */
export function disposeAllOwnedSdkRealms(): void {
  for (const realm of [...ownedRealms].reverse()) realm.dispose();
}
