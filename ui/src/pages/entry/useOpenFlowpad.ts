import { t } from '@lingui/core/macro';
import { ActionInfo, dataManager, TypeId } from '@sdk';
import { useCallback } from 'react';

/** Port the local FlowPad desktop backend listens on (flow_sdk `flow start`). */
export const LOCAL_PORT = 9007;
/**
 * Mirrors `API_PREFIX` from ts_sdk/src/config/SDKConfig.ts ('/api/v1'). The
 * constant is not re-exported through the @sdk barrel (config/index.ts), so
 * keep the literal here — it must match the desktop backend's API prefix.
 */
export const LOCAL_API_PREFIX = '/api/v1';
/** Prefer the flowpad:// custom-protocol handoff (Electron/desktop app). */
export const OPEN_IN_ELECTRON = true;

export type UseOpenFlowpadOptions = {
  port: number | string;
  openTargetPath: string;
  openInElectron: boolean;
  protocolTimeoutMs?: number;
};

export type OpenFlowpadUrls = {
  localUrl: string;
  protocolUrl: string;
};

/**
 * Build the localhost + flowpad:// protocol URLs for the deep link. With an
 * api-key we route through /auth/login_callback so the desktop app logs the
 * user in before following `next`; without one we hit the target path directly.
 */
export function buildOpenUrls(apiKey: string | null, port: number | string, openTargetPath: string): OpenFlowpadUrls {
  if (apiKey) {
    const query = new URLSearchParams({
      'flowpad-api-key': apiKey,
      next: openTargetPath,
    }).toString();
    return {
      localUrl: `http://localhost:${port}/auth/login_callback?${query}`,
      protocolUrl: `flowpad://auth/login_callback?${query}`,
    };
  }
  return {
    localUrl: `http://localhost:${port}${openTargetPath}`,
    protocolUrl: `flowpad://${openTargetPath.replace(/^\//, '')}`,
  };
}

/**
 * Returns an opener that tries the custom protocol first (if openInElectron),
 * falling back to localhost when the OS doesn't hand the URL off (no
 * blur/pagehide within the timeout).
 */
export function useOpenFlowpad({
  port,
  openTargetPath,
  openInElectron,
  protocolTimeoutMs = 1500,
}: UseOpenFlowpadOptions) {
  return useCallback(
    (apiKey: string | null) => {
      const { localUrl, protocolUrl } = buildOpenUrls(apiKey, port, openTargetPath);

      if (!openInElectron) {
        window.location.href = localUrl;
        return;
      }

      let browserLostFocus = false;
      const markAsOpened = () => {
        browserLostFocus = true;
      };
      window.addEventListener('blur', markAsOpened, { once: true });
      window.addEventListener('pagehide', markAsOpened, { once: true });

      window.location.href = protocolUrl;

      window.setTimeout(() => {
        window.removeEventListener('blur', markAsOpened);
        window.removeEventListener('pagehide', markAsOpened);
        if (!browserLostFocus) {
          window.location.href = localUrl;
        }
      }, protocolTimeoutMs);
    },
    [port, openTargetPath, openInElectron, protocolTimeoutMs],
  );
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
 */
export function useOpenInFlowpad(openTargetPath: string): () => Promise<void> {
  const openFlowpad = useOpenFlowpad({
    port: LOCAL_PORT,
    openTargetPath,
    openInElectron: OPEN_IN_ELECTRON,
    protocolTimeoutMs: 1500,
  });
  return useCallback(async () => {
    try {
      const me = await dataManager.getCurrentUser();
      const userId = me?.id;
      if (!userId) {
        openFlowpad(null);
        return;
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
      openFlowpad(apiKey ?? null);
    } catch {
      openFlowpad(null);
    }
  }, [openFlowpad]);
}
