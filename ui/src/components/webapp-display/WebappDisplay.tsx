import type { ServedApp } from '@sdk';
import { webappAsset } from '@src/components/project-setup/use-project-load';
import PersistentIframe, { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import type { WebappVerdict } from './classify';
import { WebDebugComponent } from './WebDebugComponent';
import { WebappErrorBanner } from './WebappErrorBanner';
import { useWebappDiagnostics } from './useWebappDiagnostics';
import { useWebappFix } from './useWebappFix';
import { ProjectLoadGate } from '@src/components/project-setup/ProjectLoadGate';

export interface WebappDisplayProps {
  /** The endpoint serving what the frame shows — the probe asks it what is wrong,
   *  and the repair run is pointed at it. */
  endpoint: ServedApp | null;
  /** The URL the frame loads: the endpoint's direct address or its service path. */
  src: string;
  testId?: string;
  /** Bumped by the caller to force a reload (re-show, agent turn end). */
  cacheKey?: number;
  /** App directory, handed to the repair agent when known. */
  workdir?: string | null;
  /** Subject the repair run attaches to, so it survives a refresh. */
  targetTypeId?: string | null;
}

/**
 * The one way to put a web app on screen.
 *
 * Everything about a web app that is not "render an iframe" lives here: is it
 * actually up, what is wrong with it, what do we tell the user, and how do they
 * get it fixed. `PersistentIframe` underneath is left as a pure mechanism, which
 * is the point — it has no way to know whether the thing it loaded worked. A
 * cross-origin navigation to a refused port still fires `onload`, so the frame's
 * own events can never be the source of truth. `useWebappDiagnostics` is.
 *
 * Three outcomes, chosen by one question — can the user see and use the app?
 *   fatal    → replace the frame with the debug panel; there is nothing to look at
 *   degraded → keep the app, add a banner; it works, but something is wrong
 *   ok       → get out of the way
 *
 * An app that is simply not running yet is not broken: a project's web app is a node of the project's
 * setup tree. A display that finds it down invokes the same Load gate as Open: operational work runs,
 * missing installation asks for approval, and failures remain actionable in the gate.
 */
export const WebappDisplay = forwardRef<PersistentIframeHandle, WebappDisplayProps>(function WebappDisplay(
  { endpoint, src, testId, cacheKey = 0, workdir, targetTypeId },
  ref,
) {
  const frameRef = useRef<PersistentIframeHandle>(null);
  const [dismissedBanner, setDismissedBanner] = useState<string | null>(null);

  const diagnostics = useWebappDiagnostics({ endpoint, host: src });

  const fix = useWebappFix({
    verdict: diagnostics,
    endpoint,
    url: src,
    workdir,
    targetTypeId,
    onFinished: () => {
      diagnostics.refresh();
      frameRef.current?.refresh();
    },
  });

  // Hold the verdict steady for the duration of a repair. The agent typically
  // restarts the dev server, which makes the app flicker through healthy and
  // back; without latching, the panel would swap out from under the user
  // mid-repair. Render-phase setState (not a ref write) so this stays safe
  // under StrictMode and concurrent rendering.
  const [latched, setLatched] = useState<WebappVerdict | null>(null);
  if (fix.running && !latched) setLatched(diagnostics);
  if (!fix.running && latched) setLatched(null);
  const verdict = latched ?? diagnostics;

  const refreshAll = useCallback(() => {
    diagnostics.refresh();
    frameRef.current?.refresh();
  }, [diagnostics.refresh]);

  // The app's own node of its project's setup tree — run once when the display finds the app down.
  const setupRoot = webappAsset(endpoint?.webapp_id);
  const setupProject = setupRoot ? (endpoint?.project_id ?? '') : '';
  const needsSetup = !!setupProject && verdict.severity === 'fatal' && verdict.code === 'not_running';


  useImperativeHandle(
    ref,
    () => ({
      refresh: refreshAll,
      postToGuest: (message: unknown) => frameRef.current?.postToGuest(message),
      isGuest: (source: MessageEventSource | null) => frameRef.current?.isGuest(source) ?? false,
    }),
    [refreshAll],
  );

  // A fatal failure repairs itself once, unprompted. Soft errors never do: the
  // app still works, so spending tokens without being asked would be presumptuous
  // (and noisy on apps that log a benign console error every load).
  useEffect(() => {
    if (verdict.severity !== 'fatal') return;
    if (needsSetup || fix.running || fix.autoAttempted) return;
    fix.start();
  }, [verdict.severity, needsSetup, fix.running, fix.autoAttempted, fix.start]);

  // Every fatal branch unmounts the frame, so what it parked is the broken page. Coming back from one
  // must load the app again even when the port never went away (a 500, a crash on start, a repair) —
  // unless the port did go away and come back, which `reloadNonce` has already counted.
  const [recoveries, setRecoveries] = useState(0);
  const fatalAt = useRef<number | null>(null);
  useEffect(() => {
    if (verdict.severity === 'fatal') {
      fatalAt.current ??= diagnostics.reloadNonce;
      return;
    }
    if (fatalAt.current === diagnostics.reloadNonce) setRecoveries((n) => n + 1);
    fatalAt.current = null;
  }, [verdict.severity, diagnostics.reloadNonce]);

  const showBanner = verdict.severity === 'degraded' && dismissedBanner !== verdict.code;

  if (needsSetup) {
    return <ProjectLoadGate projectId={setupProject} asset={setupRoot}><RefreshLoadedApp refresh={refreshAll} /></ProjectLoadGate>;
  }

  if (verdict.severity === 'fatal') {
    return (
      <WebDebugComponent
        verdict={verdict}
        fixRunning={fix.running}
        toolCount={fix.toolCount}
        onFix={fix.start}
        onRetry={refreshAll}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="webapp-display">
      {showBanner && (
        <WebappErrorBanner
          verdict={verdict}
          fixRunning={fix.running}
          onFix={fix.start}
          onDismiss={() => setDismissedBanner(verdict.code)}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {verdict.severity === 'unknown' && !diagnostics.probe && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-background"
            data-testid="webapp-starting"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-foreground" />
              <p className="text-sm text-muted-foreground">
                <Trans>Starting your app…</Trans>
              </p>
            </div>
          </div>
        )}
        <PersistentIframe
          ref={frameRef}
          src={src}
          testId={testId}
          // The registry parks a dead frame rather than destroying it, so an app
          // that recovers would otherwise re-reveal Chrome's error page. The
          // reload nonce advances on every down→up edge to force a real reload.
          cacheKey={cacheKey + diagnostics.reloadNonce + recoveries}
        />
      </div>
    </div>
  );
});

/** Refresh diagnostics once the provider Load has completed, without starting installation behind approval. */
function RefreshLoadedApp({ refresh }: { refresh: () => void }) {
  useEffect(refresh, [refresh]);
  return <p role="status" className="p-8 text-sm text-muted-foreground"><Trans>Checking the app…</Trans></p>;
}
