import { t } from '@lingui/core/macro';
import { ActionInfo, dataManager, TypeId } from '@sdk';
import { useCallback } from 'react';

/**
 * Mirrors `API_PREFIX` from ts_sdk/src/config/SDKConfig.ts ('/api/v1'). The
 * constant is not re-exported through the @sdk barrel (config/index.ts), so
 * keep the literal here — it must match the desktop backend's API prefix.
 */
export const LOCAL_API_PREFIX = '/api/v1';

/**
 * The flowpad:// deep link. With an api-key it routes through
 * /auth/login_callback so the desktop app logs the user in before following
 * `next`; without one it hits the target path directly.
 */
export function buildProtocolUrl(apiKey: string | null, openTargetPath: string): string {
  if (apiKey) {
    const query = new URLSearchParams({
      'flowpad-api-key': apiKey,
      next: openTargetPath,
    }).toString();
    return `flowpad://auth/login_callback?${query}`;
  }
  return `flowpad://${openTargetPath.replace(/^\//, '')}`;
}

/**
 * How long after the deep link is fired the browser has to show it is handing
 * off (its "Open FlowPad?" prompt, or the app taking focus) before we conclude
 * nothing opened. Counted from the navigation, not from the click: minting the
 * api-key first takes seconds, and the prompt only appears once we navigate.
 */
const HANDOFF_WINDOW_MS = 1500;

/**
 * Fire the deep link and report whether the browser appears to have handed it
 * off: the page lost focus, was hidden, or is still unfocused when the window
 * ends. `false` means nothing reacted, i.e. no app is registered for `flowpad://`.
 */
export function fireDeepLink(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (handedOff: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener('blur', onHandoff);
      window.removeEventListener('pagehide', onHandoff);
      document.removeEventListener('visibilitychange', onVisibility);
      resolve(handedOff);
    };
    const onHandoff = () => finish(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish(true);
    };
    const timer = window.setTimeout(() => finish(!document.hasFocus()), HANDOFF_WINDOW_MS);
    window.addEventListener('blur', onHandoff);
    window.addEventListener('pagehide', onHandoff);
    document.addEventListener('visibilitychange', onVisibility);
    window.location.href = url;
  });
}

/**
 * "Open in FlowPad" for an entry page: mint a short-lived api-key for the
 * signed-in hub user, then hand the desktop `openTargetPath` through the
 * deep link (`/auth/login_callback?next=…`), so the desktop is logged in as the
 * same person before it follows the path. `openTargetPath` is any same-origin
 * desktop path — an action URL (`/api/v1/graph/flow_message/<id>/open`) or a UI
 * route (`/dock/home?action=open&…`); `login_callback` redirects to either.
 *
 * Without a user or when minting fails, the link still opens, just without the
 * login hop — the desktop then uses whatever session it already has.
 *
 * Resolves `true` when the browser handed the link off (prompt shown or app
 * opened), `false` when nothing reacted — the caller then says what to do. The
 * page never navigates away either way.
 */
export function useOpenInFlowpad(openTargetPath: string): () => Promise<boolean> {
  const openFlowpad = useCallback(
    (apiKey: string | null) => fireDeepLink(buildProtocolUrl(apiKey, openTargetPath)),
    [openTargetPath],
  );
  return useCallback(async () => {
    try {
      const me = await dataManager.getCurrentUser();
      const userId = me?.id;
      if (!userId) {
        return openFlowpad(null);
      }
      const userTypeId = new TypeId('user', userId);
      const createKeyAction = new ActionInfo('api-keys', userTypeId.type, userTypeId.id, 'POST');
      createKeyAction.bodyParameters = {
        name: `flowpad-deeplink-${Date.now()}`,
        description: t`Short-lived key for Open-in-FlowPad deep link`,
        expires_in_days: 1,
      };
      const result = await dataManager.callAction<unknown, { api_key?: string; data?: { api_key?: string } }>(
        createKeyAction,
      );
      const apiKey = result?.api_key || result?.data?.api_key;
      return openFlowpad(apiKey ?? null);
    } catch {
      return openFlowpad(null);
    }
  }, [openFlowpad]);
}
