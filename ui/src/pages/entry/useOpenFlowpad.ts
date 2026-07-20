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
