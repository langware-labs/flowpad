import { AgenticProcess, Deployment, MicroApp, QueryRequest } from '@sdk';
import { useEffect, useMemo, useState } from 'react';
import { useEntitiesQuery } from '../entity-hooks';
import { useProcessWebApp } from './useProcessWebApp';

export type AppRuntime = 'dev' | 'served';

export interface AppDisplay {
  /** Which runtime the iframe is currently showing. */
  runtime: AppRuntime | null;
  /** Runtimes this app actually has right now. */
  available: AppRuntime[];
  /** iframe src for the active runtime; '' when the app has neither. */
  src: string;
  port: string | null;
  microApp: MicroApp | null;
  setRuntime: (runtime: AppRuntime) => void;
}

/**
 * Resolve an app's viewable runtime from its identity.
 *
 * An app is addressed by its Artifact; the dev server (its `Deployment`'s port)
 * and the built output (its `MicroApp`) are two ways to reach that one app, and
 * BOTH are resolved here from the artifact alone. That is what lets the URL name
 * only the artifact: a port belongs to whichever dev server happens to be up, so
 * one baked into the address goes stale the moment the server moves.
 *
 * Preference follows the caller's `preferred` on first resolve, then whatever the
 * user picks — and it re-derives when the artifact changes, so switching apps never
 * inherits the previous one's mode.
 */
export function useAppDisplay(
  process: AgenticProcess | null | undefined,
  artifactId: string | null | undefined,
  preferred: AppRuntime | null,
): AppDisplay {
  const [override, setOverride] = useState<AppRuntime | null>(null);

  // A new app re-derives its runtime rather than inheriting the last choice.
  useEffect(() => setOverride(null), [artifactId]);

  const queryRequest = useMemo(
    () =>
      new QueryRequest({
        type: MicroApp.type,
        query: { match: { artifact_id: artifactId ?? '' } },
        name: 'useAppDisplay',
      }),
    [artifactId],
  );
  const { data: microApps = [] } = useEntitiesQuery<MicroApp>(queryRequest, { enabled: !!artifactId });
  const microApp = microApps[0] ?? null;

  // The dev half of the same question, asked the same way. Kept beside the MicroApp
  // query rather than in the caller so "which port serves this artifact" has one
  // owner — two callers deriving it differently is how a stale port survives.
  const deploymentQuery = useMemo(
    () =>
      new QueryRequest({
        type: Deployment.type,
        query: { match: { artifact_id: artifactId ?? '' } },
        name: 'useAppDisplay',
      }),
    [artifactId],
  );
  const { data: deployments = [] } = useEntitiesQuery<Deployment>(deploymentQuery, { enabled: !!artifactId });
  const devPort = deployments[0]?.runtimePort ?? null;

  const devConfig = useProcessWebApp(process, devPort === null ? null : String(devPort));

  return useMemo(() => {
    const available: AppRuntime[] = [];
    if (devConfig.host) available.push('dev');
    if (microApp) available.push('served');

    // A request only wins if the app actually has that runtime right now — a
    // dev server can stop, and a stale preference must not blank the display.
    const requested = override ?? preferred;
    const runtime = requested && available.includes(requested) ? requested : (available[0] ?? null);

    return {
      runtime,
      available,
      src: runtime === 'served' ? (microApp?.viewUrl ?? '') : runtime === 'dev' ? devConfig.host : '',
      port: devPort === null ? null : String(devPort),
      microApp,
      setRuntime: setOverride,
    };
  }, [devConfig.host, devPort, microApp, override, preferred]);
}
