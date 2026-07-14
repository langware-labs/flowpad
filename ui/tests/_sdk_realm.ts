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
    const realm: OwnedSdkMainRealm = {
      sdk,
      main,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        sdk.connectionManager.dispose();
        ownedRealms.delete(realm);
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

/** Dispose every realm created through this helper in the current test file. */
export function disposeAllOwnedSdkRealms(): void {
  for (const realm of [...ownedRealms].reverse()) realm.dispose();
}
