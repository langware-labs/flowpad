import { useEffect, useRef } from 'react';
import { dataManager } from '../../index';
import { OAuthEventType, type OAuthFlowCompletePayload } from '../../services/oauth/oauth-service';

/**
 * Run `handler` when an OAuth flow for `provider` finishes.
 *
 * Every surface that starts a connect needs the same three things: subscribe to
 * OAUTH_FLOW_COMPLETE, ignore other providers, and unsubscribe on unmount. Hand
 * rolling that was how one dialog ended up holding a listener for the life of
 * the app when the user abandoned a device-code prompt.
 *
 * `handler` is read through a ref, so passing an inline closure does not
 * resubscribe on every render and the callback always sees fresh props.
 * `enabled` is for flows that only care while a connect is pending.
 */
export function useOAuthFlowComplete(
  provider: string,
  handler: (payload: OAuthFlowCompletePayload) => void,
  enabled = true,
): void {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const listener = (payload: OAuthFlowCompletePayload) => {
      if (payload.provider !== provider) return;
      latest.current(payload);
    };
    dataManager.on(OAuthEventType.OAUTH_FLOW_COMPLETE, listener);
    return () => {
      dataManager.off(OAuthEventType.OAUTH_FLOW_COMPLETE, listener);
    };
  }, [provider, enabled]);
}
