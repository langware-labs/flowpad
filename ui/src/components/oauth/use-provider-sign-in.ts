import { useState } from 'react';
import { OAuthStatus, oauthService } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';

/**
 * Sign in to `provider` in this browser, the one way every setup screen does it: `signIn` starts the connect,
 * `connecting` holds until the flow completes, then `onGranted` (the grant landed) or `onNotFinished` (denied,
 * cancelled, failed). A connect that cannot even start calls `onError`. `listen` (default: while connecting)
 * says when a completion is this screen's to take — a screen waiting on a sign-in may listen all along.
 */
export function useProviderSignIn(
  provider: string,
  {
    onGranted,
    onNotFinished,
    onError,
    listen,
  }: { onGranted: () => void; onNotFinished?: () => void; onError: (e: unknown) => void; listen?: boolean },
) {
  const [connecting, setConnecting] = useState(false);
  const signIn = async () => {
    if (!provider) return;
    setConnecting(true);
    try {
      await oauthService.connect(provider);
    } catch (e: unknown) {
      setConnecting(false);
      onError(e);
    }
  };
  useOAuthFlowComplete(
    provider,
    (msg) => {
      setConnecting(false);
      if (msg.status === OAuthStatus.SUCCESS) onGranted();
      else onNotFinished?.();
    },
    listen ?? connecting,
  );
  return { connecting, signIn };
}
