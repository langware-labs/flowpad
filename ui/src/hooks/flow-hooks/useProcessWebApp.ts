import { AgenticProcess } from '@sdk';
import { useMemo } from 'react';

export interface WebAppConfig {
  /** Direct `get-host` URL (redirects to the dev server; cross-origin iframe). */
  host: string;
  cacheKey: number;
}

/**
 * Build the live-preview URL from the running process's explicit port.
 * Artifact is the logical/source plane and deliberately carries no runtime
 * port; placement/runtime discovery belongs to Deployment.
 */
export function useProcessWebApp(flow: AgenticProcess | null | undefined, port: string | null | undefined): WebAppConfig {
  const webAppConfig = useMemo(() => {
    if (!port || !flow) {
      return { host: '', cacheKey: 0 };
    }

    return {
      host: flow.getWebAppHostUrl(port),
      cacheKey: Date.now(),
    };
  }, [flow, port]);

  return webAppConfig;
}
