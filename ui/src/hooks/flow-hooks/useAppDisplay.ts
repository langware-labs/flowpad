import { QueryRequest, ServiceEndpoint, TypeId } from '@sdk';
import { useTheme } from 'next-themes';
import { useViewMode } from '@src/contexts/view-mode-context';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Which runtime the iframe is currently showing. */
  runtime: AppRuntime | null;
  /** Runtimes this app actually has right now. */
  available: AppRuntime[];
  /** iframe src for the active runtime; '' when the app has neither. */
  src: string;
  /** The endpoint the active runtime is served by — what the display probes and
   *  the repair agent is pointed at. Null when nothing serves the app. */
  endpoint: ServiceEndpoint | null;
  /** The host's CURRENT appearance — colour scheme and view mode. The frame is
   *  addressed with the skin it had at mount, so a later change is pushed to the
   *  guest rather than re-addressed; see the `initialSkin` note below. */
  theme: 'light' | 'dark';
  view: string;

  setRuntime: (runtime: AppRuntime) => void;
}

/** The query for the endpoints serving an app, by the field that names it. */
function endpointsBy(field: 'artifact_id' | 'webapp_id', id: string | null): QueryRequest {
  return new QueryRequest({ type: ServiceEndpoint.type, query: { match: { [field]: id ?? '' } }, name: 'useAppDisplay' });
}

/**
 * The address a BROWSER loads a dev server at — resolved from its endpoint now,
 * never stored (`direct-url`: localhost on a desktop, the box's public host in a
 * sandbox). Re-resolved when the endpoint changes; '' until it answers.
 */
function useDirectUrl(endpoint: ServiceEndpoint | null): string {
  const { data } = useQuery({
    queryKey: ['service_endpoint', endpoint?.id ?? null, 'direct-url'],
    queryFn: () => endpoint!.directUrl().catch(() => ''),
    enabled: !!endpoint,
    staleTime: Infinity,
  });
  return endpoint ? (data ?? '') : '';
}

/**
 * Resolve an app's viewable runtime from its address — always through the
 * `ServiceEndpoint`s that serve it.
 *
 * A `proxy` endpoint is a dev server (`dev`, loaded at its own origin — HMR and
 * absolute `/src/...` paths need that); a `static` one is a folder this backend
 * serves (`served`, loaded through `service`). The address names the app —
 * its artifact, its webapp definition, or the endpoint itself — never a port.
 * Only THIS machine's endpoints count: a cloud placement of the same app is not
 * served here.
 *
 * Preference follows the caller's `preferred` on first resolve, then whatever the
 * user picks — and it re-derives when the app changes, so switching apps never
 * inherits the previous one's mode.
 */
export function useAppDisplay(
  address: Pick<AppDockAddress, 'artifactId' | 'microAppId' | 'endpointId' | 'options'> | null | undefined,
  preferred: AppRuntime | null,
): AppDisplay {
  const [override, setOverride] = useState<AppRuntime | null>(null);
  const artifactId = address?.artifactId ?? null;
  const microAppId = address?.microAppId ?? null;
  const endpointId = address?.endpointId ?? null;
  // A cross-origin guest cannot see the `.dark` class the host writes on its own
  // <html>, so the theme rides the iframe URL and the guest's first paint is
  // already correct. Deliberately NOT a dock option: the theme is not part of the
  // address, and putting it there would spell it into the user's URL bar.
  //
  // FROZEN at mount, and that is the whole point. `src` is the React key AND the
  // iframe registry's key, so changing it builds a NEW guest document — the app
  // reloads and re-establishes its subscriptions, while the outgoing frame stays
  // in the registry (nothing calls its cleanup) with its watches still live. A
  // theme toggle must not cost that, and with `enableSystem` an OS light/dark
  // schedule would trigger it unattended. Later changes are pushed to the guest
  // instead — see `AppDisplayViewer`.
  // Two axes, because the app's appearance is two: the colour scheme and the
  // view mode. Vibe is not a tint — it changes the primary colour, the corner
  // radius and the ring — so a guest given only the scheme renders the desk skin
  // inside a vibe window.
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const view = useViewMode();
  const initialSkin = useRef({ theme, view, ...hostBrand() }).current;
  // A string, so the result memo below compares it by VALUE — the caller may
  // hand us a fresh options object every render without remounting the frame.
  const appQuery = new URLSearchParams({
    ...(address?.options ?? {}),
    theme: initialSkin.theme,
    view: initialSkin.view,
    ...(initialSkin.primary ? { primary: initialSkin.primary } : {}),
    ...(initialSkin.primaryInk ? { primaryInk: initialSkin.primaryInk } : {}),
  }).toString();

  // A new app re-derives its runtime rather than inheriting the last choice.
  useEffect(() => setOverride(null), [artifactId, microAppId, endpointId]);

  const endpointTypeId = useMemo(
    () => (endpointId ? new TypeId(ServiceEndpoint.type, endpointId) : null),
    [endpointId],
  );
  const { data: addressed } = useEntity<ServiceEndpoint>(endpointTypeId);
  const byArtifact = useMemo(() => endpointsBy('artifact_id', artifactId), [artifactId]);
  const byWebapp = useMemo(() => endpointsBy('webapp_id', microAppId), [microAppId]);
  const { data: artifactRows = [] } = useEntitiesQuery<ServiceEndpoint>(byArtifact, { enabled: !!artifactId });
  const { data: webappRows = [] } = useEntitiesQuery<ServiceEndpoint>(byWebapp, { enabled: !!microAppId });

  const rows: ServiceEndpoint[] = endpointId
    ? addressed
      ? [addressed]
      : []
    : artifactId
      ? artifactRows
      : webappRows;
  // This machine's rows only: a cloud placement of the same app is not served here.
  const local = rows.filter((endpoint) => !endpoint.remote);
  const devEndpoint = local.find((endpoint) => endpoint.backend.type === 'proxy') ?? null;
  const servedEndpoint = local.find((endpoint) => endpoint.backend.type === 'static') ?? null;
  const devUrl = useDirectUrl(devEndpoint);
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
      runtime,
      available,
      src: withQuery(runtime === 'served' ? servedUrl : runtime === 'dev' ? devUrl : '', appQuery),
      endpoint: runtime === 'served' ? servedEndpoint : runtime === 'dev' ? devEndpoint : null,
      theme,
      view,
      setRuntime: setOverride,
    };
  }, [appQuery, devUrl, devEndpoint, override, preferred, servedEndpoint, servedUrl, theme, view]);
}
