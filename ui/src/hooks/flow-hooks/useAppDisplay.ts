import { AgenticProcess, MicroApp, QueryRequest } from '@sdk';
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
 * An app is addressed by its Artifact; the dev server (a `Deployment` port,
 * arriving on the show target) and the built output (its `MicroApp`) are two
 * ways to reach that one app. Preference follows the backend's derived
 * `runtime` on first resolve, then whatever the user picks — and it re-derives
 * when the artifact changes, so switching apps never inherits the previous
 * one's mode.
 */
export function useAppDisplay(
  process: AgenticProcess | null | undefined,
  artifactId: string | null | undefined,
  port: string | null,
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

  const devConfig = useProcessWebApp(process, port);

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
      port,
      microApp,
      setRuntime: setOverride,
    };
  }, [devConfig.host, microApp, override, preferred, port]);
}
