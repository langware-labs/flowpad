import { AgenticProcess, Deployment, MicroApp, QueryRequest, TypeId } from '@sdk';
import { useTheme } from 'next-themes';
import { useViewMode } from '@src/contexts/view-mode-context';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppDockAddress } from '@src/navigation/app-dock';
import { useEntitiesQuery, useEntity } from '../entity-hooks';
import { useProcessWebApp } from './useProcessWebApp';

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
  port: string | null;
  microApp: MicroApp | null;
  /** The host's CURRENT appearance — colour scheme and view mode. The frame is
   *  addressed with the skin it had at mount, so a later change is pushed to the
   *  guest rather than re-addressed; see the `initialSkin` note below. */
  theme: 'light' | 'dark';
  view: string;

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
      theme,
      view,
      setRuntime: setOverride,
    };
  }, [appQuery, devConfig.host, devPort, microApp, override, preferred, theme, view]);
}
