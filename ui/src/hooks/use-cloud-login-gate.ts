import { useCallback } from 'react';
import { oauthService, OAUTH_PROVIDERS } from '@sdk';
import { useContext } from '@sdk/react/hooks';

export type CloudLoginGateResult = { ok: true } | { ok: false; error: string };

/**
 * Gate hub-bound actions on cloud login. If the user is not logged in, opens
 * the OAuth flow and waits for it to complete; resolves `{ ok: true }` so the
 * caller can resume the original action on the same click. On cancel/error,
 * resolves `{ ok: false, error }` so the caller can surface a message.
 */
export function useCloudLoginGate(): () => Promise<CloudLoginGateResult> {
  const { cloudLoginAvailable } = useContext();
  return useCallback(async () => {
    if (cloudLoginAvailable) return { ok: true };
    try {
      await oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Login was canceled.' };
    }
  }, [cloudLoginAvailable]);
}
