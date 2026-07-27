import { useCallback } from 'react';
import { dataContext, oauthService, OAUTH_PROVIDERS } from '@sdk';

export type CloudLoginGateResult = { ok: true } | { ok: false; error: string };

/** In-flight connect, shared across every gate call. */
let _pendingConnect: Promise<unknown> | null = null;

/**
 * Gate hub-bound actions on cloud login. If the user is not logged in, opens
 * the OAuth flow and waits for it to complete; resolves `{ ok: true }` so the
 * caller can resume the original action on the same click. On cancel/error,
 * resolves `{ ok: false, error }` so the caller can surface a message.
 *
 * Login state is read LIVE from `dataContext` on every call, never from a
 * render snapshot: one user action can gate several times inside a single
 * async chain (the group-task flow gates once for `create-group-task`, then
 * again per member message). A captured `cloudLoginAvailable` still reads
 * `false` for calls 2..N — a running closure doesn't see the re-render — so it
 * re-opened the login window once per call. `_pendingConnect` collapses
 * genuinely concurrent callers onto that same single window.
 */
export function useCloudLoginGate(): () => Promise<CloudLoginGateResult> {
  return useCallback(async () => {
    if (dataContext.cloudLoginAvailable) return { ok: true };
    try {
      _pendingConnect ??= oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
      await _pendingConnect;
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Login was canceled.' };
    } finally {
      _pendingConnect = null;
    }
  }, []);
}
