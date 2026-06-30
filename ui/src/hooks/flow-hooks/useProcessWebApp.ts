import { ActionInfo, AgenticProcess, ArtifactType, Flow } from '@sdk';
import { useMemo } from 'react';
import { useCurrentArtifacts } from './useCurrentArtifacts';

export interface WebAppConfig {
  host: string;
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
      return { host: '', cacheKey: 0 };
    }

    // `get-host` is registered on the AgenticProcess entity (the legacy Flow
    // entity was removed). The active "flow" from AgentContext is an
    // AgenticProcess, so target that type — using Flow.type 404s.
    const entityType = flow instanceof AgenticProcess ? AgenticProcess.type : Flow.type;
    const actionInfo = new ActionInfo('get-host', entityType, flow.id);
    actionInfo.queryParameters = { port: _port };

    return {
      host: actionInfo.fullActionUrl,
      cacheKey,
    };
  }, [artifacts, flow, port]);

  return webAppConfig;
}
