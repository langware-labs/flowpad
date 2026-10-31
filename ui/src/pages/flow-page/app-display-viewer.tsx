import { useCallback, useEffect, useRef } from 'react';
import { reloadOnNewEpoch, type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebappDisplay } from '@src/components/webapp-display/WebappDisplay';
import { AppLifecyclePanel } from '@src/components/webapp-display/AppLifecyclePanel';
import { useAppLifecycle } from '@src/components/webapp-display/useAppLifecycle';
import { hostBrand, useAppDisplay } from '@src/hooks/flow-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { type AppRuntime } from '@src/navigation/app-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { useContext } from '@src/hooks/useContext';
import { tryParseDock } from '@src/navigation/try-parse-dock';
import { buildDockPointer } from '@src/navigation/entity-pointer';
import { Trans } from '@lingui/react/macro';
import { isTypeId, TypeId, WebApp } from '@sdk';
import { Loader2 } from 'lucide-react';
import { externalUrl, OPEN_EXTERNAL_MESSAGE } from '@sdk/apps/host';
import { openExternal } from '@src/lib/open-external';
import { isHubRelayed } from '@src/lib/hub-relayed';
import { Button } from '@src/components/ui/button';
import { Pencil } from 'lucide-react';

/**
 * An app, rendered from its ADDRESS, through the endpoints that serve it.
 *
 * `/dock/app/artifact-<id>` names an app built from source; which endpoint serves it —
 * its dev server or the build we host — is derived here, never read out of the URL.
 * That is the whole point of addressing the artifact: a dev server that dies, or a
 * build that lands, changes what you see without changing where you are.
 *
 * `/dock/app/micro_app-<id>` names a webapp ASSET (served by the endpoint indexing
 * gave it) and `/dock/app/service_endpoint-<id>` names an endpoint directly (a bare
 * dev server). Same viewer, same toolbar.
 *
 * `?runtime=` is the one runtime fact the URL does carry, and only as the user's
 * PREFERENCE. `useAppDisplay` still validates it against what is actually available,
 * so a bookmark pinned to a `dev` server that is no longer running quietly falls
 * back to `served` instead of rendering an empty frame. Because options are excluded
 * from tab identity, flipping it re-points the same tab rather than forking one.
 */
export interface AppDisplayViewerProps {
  /** Bare artifact uuid, for an app addressed by its source plane. */
  artifactId: string | null;
  /** Bare micro_app uuid, for a webapp asset addressed by its definition. */
  microAppId?: string | null;
  /** Bare service_endpoint uuid, for an app addressed by what serves it. */
  endpointId?: string | null;
  /** With `endpointId`: the app's mount on it — the endpoint is its placement's audience proxy. */
  route?: string | null;
  /** The user's runtime preference from the URL, if it pins one. */
  runtime?: AppRuntime | null;
  /** Dock options handed to the app as its query string (e.g. `source`). */
  options?: Record<string, string>;
  /** The host's content epoch — a re-show of the same app, or the agent's turn
   *  end. A change reloads the frame; see `reloadOnNewEpoch`. */
  reloadKey?: number;
  /** Pooled (`AppPool`): whether a slot shows this view right now. A view kept for its tab while
   *  another is on screen is `false`; coming back re-checks the app's files. Defaults to true. */
  active?: boolean;
  /** Pooled: told the frame's `src` whenever it changes, so the pool can free the frame when its
   *  tab closes. */
  onFrameSrc?: (src: string) => void;
}

/** The served folder's version the frame was loaded at, by `src` (see `content_version` on the server). */
const loadedVersion = new Map<string, string>();
const VERSION_MARK = /<!-- flowpad-content-version: ([0-9a-f]+) -->/;

/**
 * Reload a parked frame whose app files changed since it loaded. Re-opening a tab hands the
 * same document back (the frame is kept per `src`), so an app edited meanwhile kept showing
 * its old code until a manual reload. One small read of the page per show; same version, no reload.
 */
async function reloadIfAppChanged(src: string, reload: () => void): Promise<void> {
  if (!src) return;
  let version: string | undefined;
  try {
    const page = await fetch(src, { cache: 'no-store' });
    version = page.ok ? VERSION_MARK.exec(await page.text())?.[1] : undefined;
  } catch {
    return; // unreachable now: the frame shows its own error
  }
  if (!version) return;
  const seen = loadedVersion.get(src);
  loadedVersion.set(src, version);
  if (seen !== undefined && seen !== version) reload();
}

/**
 * The dock a guest app asks the host to open, or null: `{type: 'flowpad:navigate', address: '/dock/…'}`
 * (only a `/dock/` address that parses is honoured — a guest navigates the app, never the window to
 * an arbitrary URL), or `{…, typeid}` — an entity, opened where its type lives, inside the current
 * project: the same rule an entity chip follows (`buildDockPointer`, then rebased onto the project).
 */
export function guestNavigation(data: unknown, projectId?: string | null): DockPointer | null {
  const message = data as { type?: unknown; address?: unknown; typeid?: unknown } | null;
  if (message?.type !== 'flowpad:navigate') return null;
  if (typeof message.typeid === 'string' && isTypeId(message.typeid)) {
    const typeId = new TypeId(message.typeid);
    const pointer = buildDockPointer({ type: typeId.type, id: typeId.id }, undefined);
    return pointer ? DockPointer.rebaseAssetsOntoProject(pointer, projectId) : null;
  }
  if (typeof message.address !== 'string' || !message.address.startsWith('/dock/')) return null;
  return tryParseDock(message.address);
}

/**
 * The outside page a guest app asks the host to open (`{type: 'flowpad:open-external', url}`, the
 * SDK's `openExternal`), or null. Only an absolute http(s) address: a guest never gets a
 * `file:`, `javascript:` or app-internal URL opened on its behalf.
 */
export function guestExternalUrl(data: unknown): string | null {
  const message = data as { type?: unknown; url?: unknown } | null;
  return message?.type === OPEN_EXTERNAL_MESSAGE ? externalUrl(message.url) : null;
}

export function AppDisplayViewer({
  artifactId,
  microAppId = null,
  endpointId = null,
  route = null,
  runtime,
  options,
  reloadKey,
  active = true,
  onFrameSrc,
}: AppDisplayViewerProps) {
  const { currentDock, navigation } = useDockNavigation();
  const { project } = useContext();
  const frameRef = useRef<PersistentIframeHandle>(null);

  // No memo: `useAppDisplay` reduces this to strings before anything depends on
  // it, so a fresh object per render produces an identical `src` and the frame
  // (keyed on `src`) does not remount.
  const appDisplay = useAppDisplay(
    { artifactId, microAppId, endpointId, route, options: options ?? {} },
    runtime ?? null,
  );

  // The webapp asset behind what is shown — named by the address, or by the route serving it. Its lifecycle
  // record decides whether the frame is on screen; opening it asks the backend to make it work, once.
  const webappId = microAppId ?? appDisplay.endpoint?.webapp_id ?? appDisplay.idleDev?.webapp_id ?? null;
  // Files served as they are need nothing brought up, wherever they live (a mock in $TMPDIR).
  const servedFiles = appDisplay.endpoint?.backend?.type === 'static';
  const lifecycle = useAppLifecycle(appDisplay.loading ? null : webappId, {
    display: currentDock?.hostProcessId ?? '',
    autoUp: active && !servedFiles,
  });
  const definition = microAppId ? lifecycle.app : null;

  useEffect(() => {
    reloadOnNewEpoch(appDisplay.src, reloadKey, () => frameRef.current?.refresh());
  }, [appDisplay.src, reloadKey]);

  useEffect(() => {
    if (active) void reloadIfAppChanged(appDisplay.src, () => frameRef.current?.refresh());
  }, [appDisplay.src, active]);

  useEffect(() => {
    if (appDisplay.src) onFrameSrc?.(appDisplay.src);
  }, [appDisplay.src, onFrameSrc]);

  // An app the hub relays cannot run in this frame (`hub-relayed.ts`): it is offered in a tab of its own.
  const relayed = isHubRelayed(appDisplay.src);

  // The theme is baked into the guest URL for its first paint, so a later change
  // is PUSHED rather than re-addressed: re-addressing would swap `src`, which is
  // the frame's identity, and reload the whole app to recolour it.
  // Keyed on `src` as well as the theme: the URL is only a SEED for first paint,
  // and a new frame identity (a runtime switch, a different app in this dock)
  // carries whatever theme was frozen at mount. Pushing on every new frame makes
  // the channel the authority, which is what the seed comment above promises.
  const pushSkin = useCallback(() => {
    frameRef.current?.postToGuest({
      type: 'flowpad:theme',
      theme: appDisplay.theme,
      view: appDisplay.view,
      // Read at send time: the palette is applied by an effect, so a value
      // captured during render is empty on a deep-linked first paint.
      ...hostBrand(),
    });
  }, [appDisplay.theme, appDisplay.view]);

  // Push when the skin moves, and answer the guest's own request — a guest that
  // finished loading after our push would otherwise never hear one.
  // One listener for what the guest asks: its skin (answered to any window, as it always was), and
  // to open another dock (the eval browser → the dataset editor) or an outside page (a record in
  // a CRM) — URL-first, the host only navigates, and only for this frame's own guest.
  useEffect(() => {
    pushSkin();
    const onGuest = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'flowpad:skin-please') return pushSkin();
      if (!frameRef.current?.isGuest(event.source)) return;
      const dock = guestNavigation(event.data, project?.id);
      if (dock) return navigation.openDock(dock);
      const outside = guestExternalUrl(event.data);
      if (outside) openExternal(outside);
    };
    window.addEventListener('message', onGuest);
    return () => window.removeEventListener('message', onGuest);
  }, [pushSkin, appDisplay.src, navigation, project?.id]);

  // Nothing is known until the endpoints serving the app answered: an app not looked up yet is not down.
  if (appDisplay.loading) return null;
  // The app itself is not on this machine (removed, or a link from another one): there is nothing to
  // bring up or wait for, and saying "opening" forever would be a lie.
  if (microAppId && lifecycle.notFound && !appDisplay.src) {
    return (
      <div
        role="alert"
        data-testid="app-not-installed"
        className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        <Trans>This app is not installed here. Add its project again from the project that uses it.</Trans>
      </div>
    );
  }
  if (!appDisplay.src && webappId) {
    // Not served yet: the record says what the backend is doing; up but not re-read yet, a moment's status.
    return lifecycle.showable ? (
      <div className="flex h-full items-center justify-center" data-testid="app-opening">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    ) : (
      <AppLifecyclePanel lifecycle={lifecycle} />
    );
  }

  if (!appDisplay.src) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <Trans>This app has no running dev server and no built output yet.</Trans>
      </div>
    );
  }

  const display = (
    <div className="flex h-full flex-col">
      {/* The website view is the app: one header button to edit it, nothing else. */}
      {definition ? (
        <div className="flex items-center justify-end border-b px-3 py-1" data-testid="webapp-header">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            data-testid="webapp-edit"
            onClick={() => navigation.openDock(DockPointer.forAssetEditorByTypeId(WebApp.type, definition.typeId))}
          >
            <Pencil className="size-3.5" />
            <Trans>Edit app</Trans>
          </Button>
        </div>
      ) : null}
      {relayed ? (
        <div
          data-testid="app-opens-in-tab"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
        >
          <p className="text-lg font-medium">
            <Trans>This app is served externally via Flowpad. Open it in a new tab.</Trans>
          </p>
          <Button onClick={() => openExternal(appDisplay.src)}>
            <Trans>Open in new tab</Trans>
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <WebappDisplay
            // Keyed by src so a runtime switch REMOUNTS the wrapper. Changing src in
            // place leaves both the outgoing and incoming frames parked at opacity-0:
            // the iframe registry activates a container on mount, and an in-place src
            // change retires the old one without ever activating the new one.
            key={appDisplay.src}
            ref={frameRef}
            endpoint={appDisplay.endpoint}
            testId="vibe-app-frame"
            src={appDisplay.src}
            lifecycle={webappId && !servedFiles ? lifecycle : null}
          />
        </div>
      )}
    </div>
  );
  return display;
}
