import { QueryRequest, ServedApp, ServiceEndpoint, TypeId, WEB_AUDIENCES } from '@sdk';
import { useTheme } from 'next-themes';
import { useViewMode } from '@src/contexts/view-mode-context';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { AppDockAddress } from '@src/navigation/app-dock';
import { useEntitiesQuery, useEntity } from '../entity-hooks';

export type AppRuntime = 'dev' | 'served';

/**
 * The two tokens the app brands at RUNTIME rather than in its stylesheet:
 * `useColorPalette` writes them inline on `<html>` from the site config, so the
 * generated `/sdk/flowpad.css` cannot carry them and a white-labelled deployment
 * would show its brand everywhere except inside its own apps.
 *
 * Read live rather than cached — the palette is applied by an effect, so any
 * value captured during a first render is empty.
 */
export function hostBrand(): { primary: string; primaryInk: string } {
  if (typeof document === 'undefined') return { primary: '', primaryInk: '' };
  const root = document.documentElement.style;
  return {
    primary: root.getPropertyValue('--primary').trim(),
    primaryInk: root.getPropertyValue('--primary-foreground').trim(),
  };
}

/** Append the dock's app-facing options to a base URL, preserving any it has. */
function withQuery(base: string, query: string): string {
  if (!base || !query) return base;
  return base.includes('?') ? `${base}&${query}` : `${base}?${query}`;
}

export interface AppDisplay {
  /** The endpoints serving the app have not answered yet — nothing is known about it, least of all
   *  that it is down. */
  loading: boolean;
  /** Which runtime the iframe is currently showing. */
  runtime: AppRuntime | null;
  /** The app's dev server when it has one that does not answer (stopped, never started) — what its setup
   *  brings up. */
  idleDev: ServedApp | null;
  /** Runtimes this app actually has right now. */
  available: AppRuntime[];
  /** iframe src for the active runtime; '' when the app has neither. */
  src: string;
  /** What the active runtime is served by — the app's route on its placement's audience proxy;
   *  what the display probes and the repair agent is pointed at. Null when nothing serves the app. */
  endpoint: ServedApp | null;
  /** The host's CURRENT appearance — colour scheme and view mode. Never in `src`:
   *  it is pushed to the guest (`flowpad:theme`) by `AppDisplayViewer`. */
  theme: 'light' | 'dark';
  view: string;

  setRuntime: (runtime: AppRuntime) => void;
}

/**
 * The audience proxies — every placement's `admin` and `app` endpoint. A web app is a ROUTE of
 * one of them, so "what serves this app" is a look through their routes; there are at most two
 * per placement, and the rows are live, so a route added or moved re-derives the display.
 */
const AUDIENCE_PROXIES = WEB_AUDIENCES.map(
  (audience) =>
    new QueryRequest({ type: ServiceEndpoint.type, query: { match: { subkind: audience } }, name: 'useAppDisplay' }),
);

/** The routes serving the app named, over `proxies`. */
function servedBy(proxies: ServiceEndpoint[], field: 'artifact_id' | 'webapp_id', id: string): ServedApp[] {
  return proxies.flatMap((proxy) => proxy.served()).filter((app) => app.mount !== null && app[field] === id);
}

/**
 * Every audience proxy's rows, `app` first (its route wins over `admin`'s), and whether any is still loading.
 * One query per audience: `AUDIENCE_PROXIES` is a module constant, so the hook count never changes.
 */
function useServedApps(enabled: boolean): { proxies: ServiceEndpoint[]; loading: boolean } {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed-length module constant: same hooks every render
  const results = AUDIENCE_PROXIES.map((request) => useEntitiesQuery<ServiceEndpoint>(request, { enabled }));
  return {
    proxies: [...results].reverse().flatMap((result) => result.data ?? []),
    loading: results.some((result) => result.isLoading),
  };
}

/**
 * The webapp asset an app address names: the micro_app itself, or — for an artifact or an addressed
 * endpoint's route — the `webapp_id` of the route serving it. `loading` until the rows answer; null
 * when no webapp asset serves it. What a setup gate scopes its load to, so an app waits only for itself.
 */
export function useAppWebappId(
  artifactId: string | null,
  microAppId: string | null,
  endpointId: string | null = null,
  route: string | null = null,
): { webappId: string | null; loading: boolean } {
  const { proxies, loading } = useServedApps(!microAppId && !endpointId && !!artifactId);
  const endpointTypeId = useMemo(
    () => (endpointId && !microAppId ? new TypeId(ServiceEndpoint.type, endpointId) : null),
    [endpointId, microAppId],
  );
  const { data: addressed, isLoading: addressedLoading } = useEntity<ServiceEndpoint>(endpointTypeId);
  if (microAppId) return { webappId: microAppId, loading: false };
  if (endpointId) return { webappId: addressed?.servedAt(route)?.webapp_id ?? null, loading: addressedLoading };
  if (!artifactId) return { webappId: null, loading: false };
  const served = servedBy(proxies, 'artifact_id', artifactId);
  return { webappId: served.find((app) => app.webapp_id)?.webapp_id ?? null, loading };
}

/**
 * The address a BROWSER loads a dev server at — resolved from its endpoint now,
 * never stored (`direct-url`: localhost on a desktop, the box's public host in a
 * sandbox). Re-resolved when the endpoint changes; '' until it answers.
 */
function useDirectUrl(endpoint: ServedApp | null): { url: string; pending: boolean } {
  const port = endpoint?.backend?.type === 'proxy' ? endpoint.backend.port : null;
  const { data, isPending } = useQuery({
    // The port too: a restarted server keeps its mount and moves its address.
    queryKey: ['service_endpoint', endpoint?.id ?? null, 'direct-url', endpoint?.mount ?? null, port],
    queryFn: () => endpoint!.directUrl().catch(() => ''),
    enabled: !!endpoint,
    staleTime: Infinity,
  });
  return { url: endpoint ? (data ?? '') : '', pending: !!endpoint && isPending };
}

/**
 * Resolve an app's viewable runtime from its address — always through what serves
 * it: its routes on its placement's audience proxy (`ServedApp`).
 *
 * A `proxy` route is a dev server (`dev`, loaded at its own origin — HMR and
 * absolute `/src/...` paths need that); a `static` one is a folder this backend
 * serves (`served`, loaded through `service`). The address names the app —
 * its artifact, its webapp definition, or the proxy and its mount — never a port.
 * Only THIS machine's endpoints count: a cloud placement of the same app is not
 * served here.
 *
 * Preference follows the caller's `preferred` on first resolve, then whatever the
 * user picks — and it re-derives when the app changes, so switching apps never
 * inherits the previous one's mode.
 */
export function useAppDisplay(
  address: Pick<AppDockAddress, 'artifactId' | 'microAppId' | 'endpointId' | 'options'>
    & Partial<Pick<AppDockAddress, 'route'>>
    | null
    | undefined,
  preferred: AppRuntime | null,
): AppDisplay {
  const [override, setOverride] = useState<AppRuntime | null>(null);
  const artifactId = address?.artifactId ?? null;
  const microAppId = address?.microAppId ?? null;
  const endpointId = address?.endpointId ?? null;
  const route = address?.route ?? null;
  // The skin (theme, view mode, brand) is NOT in the URL: `src` is the frame's identity, and a
  // skin baked into it either forks a view per theme or goes stale. The host pushes the skin to
  // the guest instead (`flowpad:theme`, answered on `flowpad:skin-please`) — see `AppDisplayViewer`.
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const view = useViewMode();
  // A string, so the result memo below compares it by VALUE — the caller may
  // hand us a fresh options object every render without remounting the frame.
  const appQuery = new URLSearchParams(address?.options ?? {}).toString();

  // A new app re-derives its runtime rather than inheriting the last choice.
  useEffect(() => setOverride(null), [artifactId, microAppId, endpointId, route]);

  const endpointTypeId = useMemo(
    () => (endpointId ? new TypeId(ServiceEndpoint.type, endpointId) : null),
    [endpointId],
  );
  const { data: addressed, isLoading: addressedLoading } = useEntity<ServiceEndpoint>(endpointTypeId);
  const { proxies, loading: proxiesLoading } = useServedApps(!endpointId && !!(artifactId || microAppId));
  const loading = endpointId ? addressedLoading : proxiesLoading;

  // An addressed endpoint shows ONE app: the mount named, or — a service of its own — itself.
  const addressedApp = addressed?.servedAt(route) ?? null;
  const rows: ServedApp[] = endpointId
    ? addressedApp
      ? [addressedApp]
      : []
    : artifactId
      ? servedBy(proxies, 'artifact_id', artifactId)
      : microAppId
        ? servedBy(proxies, 'webapp_id', microAppId)
        : [];
  // This machine's rows only: a cloud placement of the same app is not served here.
  const local = rows.filter((app) => !app.remote);
  const devFound = local.find((app) => app.backend?.type === 'proxy') ?? null;
  const servedFound = local.find((app) => app.backend?.type === 'static') ?? null;
  // Held by VALUE (the proxy and the mount): `served()` builds a fresh view per render, and everything
  // downstream — the direct-url query, the frame's key — must not see a new app each time.
  const held = `${devFound?.id ?? ''}/${devFound?.mount ?? ''}|${servedFound?.id ?? ''}/${servedFound?.mount ?? ''}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const [devEndpoint, servedEndpoint] = useMemo(() => [devFound, servedFound], [held]);
  // An address not answered yet is not an idle app: until it is, nothing is chosen (no setup gate).
  const { url: devUrl, pending: devUrlPending } = useDirectUrl(devEndpoint);
  const servedUrl = servedEndpoint ? servedEndpoint.serviceUrl() : '';

  return useMemo(() => {
    const available: AppRuntime[] = [];
    if (devUrl) available.push('dev');
    if (servedUrl) available.push('served');

    // A request only wins if the app actually has that runtime right now — a
    // dev server can stop, and a stale preference must not blank the display.
    const requested = override ?? preferred;
    const runtime = requested && available.includes(requested) ? requested : (available[0] ?? null);

    return {
      loading: loading || devUrlPending,
      runtime,
      available,
      src: withQuery(runtime === 'served' ? servedUrl : runtime === 'dev' ? devUrl : '', appQuery),
      endpoint: runtime === 'served' ? servedEndpoint : runtime === 'dev' ? devEndpoint : null,
      idleDev: devEndpoint && !devUrl ? devEndpoint : null,
      theme,
      view,
      setRuntime: setOverride,
    };
  }, [appQuery, devUrl, devUrlPending, devEndpoint, loading, override, preferred, servedEndpoint, servedUrl, theme, view]);
}
