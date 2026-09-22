import { useCallback, useEffect, useRef } from 'react';
import { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebappDisplay } from '@src/components/webapp-display/WebappDisplay';
import { WebappDisplayToolbar } from '@src/components/display-toolbar';
import { hostBrand, useAppDisplay } from '@src/hooks/flow-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { APP_RUNTIME_PARAM, type AppRuntime } from '@src/navigation/app-dock';

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
  /** The user's runtime preference from the URL, if it pins one. */
  runtime?: AppRuntime | null;
  /** Dock options handed to the app as its query string (e.g. `source`). */
  options?: Record<string, string>;
  /** The host's content epoch — a re-show of the same app, or the agent's turn
   *  end. A change reloads the frame; see `reloadOnNewEpoch`. */
  reloadKey?: number;
}

/**
 * The epoch each frame was last shown at, by `src`.
 *
 * The host re-keys its body to signal "something changed behind the same
 * address", which REMOUNTS this viewer — but the iframe registry parks frames by
 * `src` and hands the same document back, so a remount alone reloads nothing, and
 * component state cannot tell a new epoch from a tab coming back into view. Held
 * per `src` here: a new epoch reloads, the same epoch does not.
 */
const shownAtEpoch = new Map<string, number>();

function reloadOnNewEpoch(src: string, epoch: number | undefined, reload: () => void): void {
  if (!src || epoch === undefined) return;
  const seen = shownAtEpoch.get(src);
  shownAtEpoch.set(src, epoch);
  if (seen !== undefined && seen !== epoch) reload();
}

export function AppDisplayViewer({
  artifactId,
  microAppId = null,
  endpointId = null,
  runtime,
  options,
  reloadKey,
}: AppDisplayViewerProps) {
  const { currentDock, navigation } = useDockNavigation();
  const frameRef = useRef<PersistentIframeHandle>(null);

  // No memo: `useAppDisplay` reduces this to strings before anything depends on
  // it, so a fresh object per render produces an identical `src` and the frame
  // (keyed on `src`) does not remount.
  const appDisplay = useAppDisplay({ artifactId, microAppId, endpointId, options: options ?? {} }, runtime ?? null);

  useEffect(() => {
    reloadOnNewEpoch(appDisplay.src, reloadKey, () => frameRef.current?.refresh());
  }, [appDisplay.src, reloadKey]);

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
  useEffect(() => {
    pushSkin();
    const onGuest = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'flowpad:skin-please') pushSkin();
    };
    window.addEventListener('message', onGuest);
    return () => window.removeEventListener('message', onGuest);
  }, [pushSkin, appDisplay.src]);

  // URL-carried, so the choice survives a reload and the Back button — it used to
  // be component state and vanished on both.
  const setRuntime = (next: string) => {
    if (currentDock) navigation.openDock(currentDock.withOption(APP_RUNTIME_PARAM, next));
  };

  if (!appDisplay.src) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This app has no running dev server and no built output yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <WebappDisplayToolbar
        host={appDisplay.src}
        // A dev server is loaded at its own address, which is worth showing; a
        // served build's address is this backend's own path.
        address={appDisplay.runtime === 'dev' ? directHost(appDisplay.src) : ''}
        runtime={appDisplay.runtime}
        runtimes={appDisplay.available}
        onRuntimeChange={setRuntime}
        onRefresh={() => frameRef.current?.refresh()}
      />
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
          // The repair run attaches to the webapp definition when there is one.
          targetTypeId={microAppId ? `micro_app-${microAppId}` : null}
        />
      </div>
    </div>
  );
}

/** `host:port` of a direct address, for the toolbar label. */
function directHost(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return '';
  }
}
