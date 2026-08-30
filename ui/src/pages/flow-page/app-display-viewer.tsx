import { useRef } from 'react';
import { AgenticProcess } from '@sdk';
import { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebappDisplay } from '@src/components/webapp-display/WebappDisplay';
import { WebappDisplayToolbar } from '@src/components/display-toolbar';
import { useAppDisplay } from '@src/hooks/flow-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { APP_RUNTIME_PARAM, type AppRuntime } from '@src/navigation/app-dock';
import { useEntity } from '@src/hooks/entity-hooks';
import { TypeId } from '@sdk';
import { useMemo } from 'react';

/**
 * An Artifact-backed app, rendered from its ADDRESS.
 *
 * `/dock/app/artifact-<id>` names the app; which runtime serves it — a dev server's
 * port or the built output we host — is derived here from the artifact's companions,
 * never read out of the URL. That is the whole point of addressing the artifact: a
 * dev server that dies, or a build that lands, changes what you see without changing
 * where you are.
 *
 * `?runtime=` is the one runtime fact the URL does carry, and only as the user's
 * PREFERENCE. `useAppDisplay` still validates it against what is actually available,
 * so a bookmark pinned to a `dev` server that is no longer running quietly falls
 * back to `served` instead of rendering an empty frame. Because options are excluded
 * from tab identity, flipping it re-points the same tab rather than forking one.
 */
export interface AppDisplayViewerProps {
  /** Bare artifact uuid (the pointer's TypeId, already split). */
  artifactId: string;
  /**
   * The workspace host, as `agentic_process-<uuid>`. Required for the `dev`
   * runtime only: that URL is resolved through the owning process's compute node
   * (`get-host`), so an app shown outside a workspace can still render its built
   * output but has no dev server to point at.
   */
  host?: string | null;
  /** The user's runtime preference from the URL, if it pins one. */
  runtime?: AppRuntime | null;
}

export function AppDisplayViewer({ artifactId, host, runtime }: AppDisplayViewerProps) {
  const { currentDock, navigation } = useDockNavigation();
  const frameRef = useRef<PersistentIframeHandle>(null);

  const processTypeId = useMemo(
    () => (host ? new TypeId(host) : null),
    [host],
  );
  const { data: process } = useEntity<AgenticProcess>(processTypeId, { enabled: !!processTypeId });

  const appDisplay = useAppDisplay(process ?? null, artifactId, runtime ?? null);

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
        port={appDisplay.port ?? ''}
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
          processId={process?.id}
          testId="vibe-app-frame"
          src={appDisplay.src}
          port={appDisplay.port}
          targetTypeId={appDisplay.microApp?.typeId?.toString() ?? null}
        />
      </div>
    </div>
  );
}
