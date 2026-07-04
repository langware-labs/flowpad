import { ActionInfo, AgenticProcess, ArtifactType, Flow } from '@sdk';
import { useMemo } from 'react';
import { useCurrentArtifacts } from './useCurrentArtifacts';

export interface WebAppConfig {
  /** Direct `get-host` URL (redirects to the dev server; cross-origin iframe). */
  host: string;
  /** `app-proxy` URL — same app served through the backend origin with the
   *  select bridge injected, so the Vibe display can read the guest DOM. */
  proxyHost: string;
  cacheKey: number;
}

/**
 * Hook to extract web app configuration from artifacts.
 * Gets the last artifact of type WEBAPP and builds the iframe URL.
 */
export function useProcessWebApp(flow: Flow | null | undefined, port: string | null | undefined): WebAppConfig {
  const { data: artifacts = [] } = useCurrentArtifacts();

  const webAppConfig = useMemo(() => {
    let cacheKey = Date.now();
    let _port = port;
    if (!_port) {
      const webApps = [...artifacts].filter((artifact) => artifact.artifact_type === ArtifactType.WEBAPP);
      const webApp = webApps.length > 0 ? webApps[webApps.length - 1] : undefined;
      if (webApp) {
        cacheKey = Number(webApp.id);
      }
      _port = webApp?.metadata?.port as string;
    }

    if (!_port || !flow) {
      return { host: '', proxyHost: '', cacheKey: 0 };
    }

    // `get-host` / `app-proxy` are registered on the AgenticProcess entity (the
    // legacy Flow entity was removed). The active "flow" from AgentContext is an
    // AgenticProcess, so target that type — using Flow.type 404s.
    const entityType = flow instanceof AgenticProcess ? AgenticProcess.type : Flow.type;
    const urlFor = (action: string) => {
      const info = new ActionInfo(action, entityType, flow.id);
      info.queryParameters = { port: _port as string };
      return info.fullActionUrl;
    };

    return {
      host: urlFor('get-host'),
      proxyHost: urlFor('app-proxy'),
      cacheKey,
    };
  }, [artifacts, flow, port]);

  return webAppConfig;
}
