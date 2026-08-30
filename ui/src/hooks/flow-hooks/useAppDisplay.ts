import { AgenticProcess, Deployment, MicroApp, QueryRequest, TypeId } from '@sdk';
import { useEffect, useMemo, useState } from 'react';
import type { AppDockAddress } from '@src/navigation/app-dock';
import { useEntitiesQuery, useEntity } from '../entity-hooks';
import { useProcessWebApp } from './useProcessWebApp';

export type AppRuntime = 'dev' | 'served';

/** Append the dock's app-facing options to a base URL, preserving any it has. */
function withQuery(base: string, query: string): string {
  if (!base || !query) return base;
  return base.includes('?') ? `${base}&${query}` : `${base}?${query}`;
}

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
 * Resolve an app's viewable runtime from its address.
 *
 * An app built from source is addressed by its Artifact; the dev server (its
 * `Deployment`'s port) and the built output (its `MicroApp`) are two ways to
 * reach that one app, and BOTH are resolved here from the artifact alone. That
 * is what lets the URL name only the artifact: a port belongs to whichever dev
 * server happens to be up, so one baked into the address goes stale the moment
 * the server moves.
 *
 * A webapp ASSET is addressed by its own delivery row instead. There is no
 * artifact to resolve from and no dev server to offer — the folder on disk is
 * the app — so that address fetches the one row directly and stops.
 *
 * Preference follows the caller's `preferred` on first resolve, then whatever the
 * user picks — and it re-derives when the app changes, so switching apps never
 * inherits the previous one's mode.
 */
export function useAppDisplay(
  process: AgenticProcess | null | undefined,
  address: Pick<AppDockAddress, 'artifactId' | 'microAppId' | 'options'> | null | undefined,
  preferred: AppRuntime | null,
): AppDisplay {
  const [override, setOverride] = useState<AppRuntime | null>(null);
  const artifactId = address?.artifactId ?? null;
  const microAppId = address?.microAppId ?? null;
  // A string, so the result memo below compares it by VALUE — the caller may
  // hand us a fresh options object every render without remounting the frame.
  const appQuery = new URLSearchParams(address?.options ?? {}).toString();

  // A new app re-derives its runtime rather than inheriting the last choice.
  useEffect(() => setOverride(null), [artifactId, microAppId]);

  // The asset address: one row, fetched by identity. No artifact query can find
  // it — a webapp asset has no Artifact — so this is not a fallback, it is the
  // other half of the grammar.
  const appTypeId = useMemo(() => (microAppId ? new TypeId(MicroApp.type, microAppId) : null), [microAppId]);
  const { data: addressedApp } = useEntity<MicroApp>(appTypeId);

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
  const microApp = (microAppId ? (addressedApp ?? null) : (microApps[0] ?? null)) as MicroApp | null;

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
      src: withQuery(runtime === 'served' ? (microApp?.viewUrl ?? '') : runtime === 'dev' ? devConfig.host : '', appQuery),
      port: devPort === null ? null : String(devPort),
      microApp,
      setRuntime: setOverride,
    };
  }, [appQuery, devConfig.host, devPort, microApp, override, preferred]);
}
