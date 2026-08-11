/**
 * react-router loader entry for the agent app routes (/dock/*, /flow/*).
 *
 * This module is the dispatcher: it initialises the SDK, resolves the
 * compute node, and hands off to view-specific loaders based on `params.viewType`.
 * Shell/process loading lives in `./load-shell` and `./load-process`.
 */

import {
  AgenticProcess,
  cloudManager,
  ContextEntitiesEnum,
  dataContext,
  initSdk,
  isBackendUnreachable,
  Project,
  systemTools,
  TypeId,
} from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation';
import { canonicalProcessDockPath } from '@src/navigation/process-dock-canonicalization';
import { canonicalCredentialsDockPath } from '@src/navigation/credentials-dock-canonicalization';
import { canonicalWorldViewDockPath } from '@src/navigation/worldview-dock-canonicalization';
import { pageRedirectUrl } from '@src/navigation/supported-pages';
import { setupTabAndAdopt } from '@src/tabs/tab-content-lifecycle';
import { ViewType } from '@src/types/ViewType';
import { TimeIt } from '@src/utils/timeit';
import { redirect, replace, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { ProjectLoadError, loadProject } from './load-project';
import { describeProcessStartError } from './load-process';
import { markPerfT0, perfLog, perfTime } from './_perf';
import { loadDockPointer } from './load-dock-pointer';
import { runLoadRedirects } from './load-redirects';
// Side-effect import: feature-owned redirect resolvers register themselves.
import '@src/journey/journey-load-redirect';

// Re-export kept for existing consumers (unit tests import from here).
export { describeProcessStartError };

/**
 * Drop a dock's scope when the project it pins does not exist, by redirecting to
 * the SAME pointer with no scope keys.
 *
 * This runs before tab materialization on purpose, and only for a SCOPE-KEYED
 * dock (Assets, Explorer), whose tab identity IS its scope
 * (`tabHash` = `<viewType>|project:<id>`). Such a tab cannot be minted for a
 * project that isn't there — `setupTab` throws "Tab could not be materialized
 * for this URL.", records OpenFailed and returns, so NOTHING downstream runs:
 * not the dock loader, not scope adoption, not any error surface. The dock is
 * abandoned and the browse views render the dead scope's zero rows as an
 * ordinary empty list. Any repair placed after this point is unreachable, which
 * is what makes this the right seam. Docks whose identity ignores scope are
 * unaffected and are left to resolve their own project (a shell derives it from
 * its process), so they pay no extra fetch here.
 *
 * Only a resolved 404/403 (`ProjectLoadError`) strips the scope. A transient
 * failure (offline, 5xx) leaves the URL alone — the project probably exists, and
 * a network blip must not silently rewrite where the user is. Ids are per
 * instance, so a dead scope is usually a stale tab/bookmark or a URL carried in
 * from another instance.
 */
async function repairUnsatisfiableScope(dock: DockPointer, requestPath: string): Promise<void> {
  if (!dock.scopeKeyed) return;
  const projectId = dock.scopeProjectId;
  if (!projectId || dataContext.project?.id === projectId) return;
  try {
    // Also warms the entity cache + context, so the dock loader's own scope
    // adoption downstream is a cache hit rather than a second round trip.
    await loadProject(new TypeId(Project.type, projectId));
  } catch (cause) {
    if (!(cause instanceof ProjectLoadError)) return;
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(dock.withoutScopeFilter().toUrl(requestPath));
  }
}

/**
 * Ensure compute node is loaded for the current project.
 * Project setup is handled by initSdk -> initContext -> setupProject.
 */
async function ensureComputeNodeLoaded(): Promise<void> {
  if (dataContext.project && !dataContext.computeNode) {
    await dataContext.refreshProject();
  }

  if (!dataContext.computeNode) {
    const bootstrapNode = dataContext.bootstrapInfo?.default_compute_node;
    if (bootstrapNode?.id && bootstrapNode?.type) {
      await dataContext.setContextEntityTypeId(
        ContextEntitiesEnum.CurrentComputeNodeTypeId,
        new TypeId(bootstrapNode.type, bootstrapNode.id),
      );
    }
  }
}

/**
 * Heal the pre-VFS Assets Files route (`fs/<relative>`) at the loader seam.
 * The replacement happens only after compute-node setup and before tab
 * materialization, so neither a tab nor UI context can adopt the legacy
 * identity. DockPointer owns the grammar conversion; React Router owns history.
 */
export function redirectLegacyAssetFsDock(dock: DockPointer, requestPath: string): void {
  const canonical = dock.canonicalLegacyAssetFsDock();
  if (!canonical) return;
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw replace(canonical.toUrl(requestPath));
}

export async function loadAgentApp(args: LoaderArgs) {
  const { params } = args;
  const requestUrl = new URL(args.request.url);
  // Stamp the per-nav perf clock at EVERY loader entry — not just click-nav.
  // The `[PERF]` breakdown (perfTime/perfLog/PtyConnection.attach) is gated on
  // `__shellNavT0`, previously stamped only by the strip/sidebar click
  // handlers. Revalidation-driven runs (URL search/path change, no click) left
  // it stale/unset, so the slow re-runs printed only TimeIt's opaque total with
  // no per-step attribution. Stamping here makes every loader run self-timing.
  markPerfT0();
  const t = new TimeIt(`loadAgentApp(${params['*'] || params.viewType || '/'})`);
  const wasColdInit = typeof window !== 'undefined' && !window.appReady;
  // Cold SDK bootstrap includes schema/context setup; warm route loads keep the
  // tighter guard so real navigation regressions still surface.
  const slowThresholdSeconds = wasColdInit ? 5 : 1.2;
  perfLog(`loadAgentApp start (${params['*'] || params.viewType || '?'})`);

  // React Router 6.4 runs root and child route loaders **in parallel** by
  // default — the root `loadRoot()` does NOT serialize child loaders behind
  // it. Without this await, a cold-load nav races: `loadAgentApp` constructs
  // entities (via `loadShellRoute → load-process.ts`) before the root
  // loader's initSdk has finished registering schemas → `isDbField`
  // schema-not-found warning storm.
  //
  // `initSdk` is idempotent (memoised via the module-level `initPromise`
  // in `ts_sdk/src/main.ts`), so this is effectively `await
  // dataManager.schemasReady` — zero work on the warm path, full
  // serialisation on the cold path.
  // Cold path = full bootstrap; warm path resolves the memoised promise (~0ms).
  await perfTime(`initSdk (${wasColdInit ? 'cold bootstrap' : 'warm'})`, () => initSdk(params));
  t.time('initSdk');

  // Check if service is unavailable - throw error so ErrorBoundary catches it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrapError = dataContext.bootstrapError as any;
  if (isBackendUnreachable(bootstrapError)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw dataContext.bootstrapError;
  }

  // Hub server + anonymous visitor: the hub app is account-scoped, so an
  // unauthenticated open goes to the login flow instead of the visitor home
  // (custom-JWT hubs auto-sign-in the local dev user; Auth0 shows the
  // universal login). Full browser navigation — the login route lives on the
  // backend, not in the SPA. Entry routes (/entry/* invite & landing pages)
  // run their own loaders and stay reachable anonymously.
  if (isHubOnly() && !dataContext.bootstrapInfo?.user) {
    t.done(slowThresholdSeconds);
    void cloudManager.login();
    // Halt this load — the browser is navigating away.
    return await new Promise<never>(() => {});
  }

  const { processId, viewType } = params;
  const pointer = params['*'] || '';

  // Legacy display-URL canonicalization: a process has ONE URL family
  // (/dock/shell/<proc>) in both modes — vibe rides the ?viewMode param. Old
  // /dock|win/display/<proc> links redirect to the shell form here (search
  // preserved) — see canonicalProcessDockPath.
  const canonical = canonicalProcessDockPath(requestUrl.pathname, requestUrl.search);
  if (canonical) {
    t.done(slowThresholdSeconds);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(canonical);
  }

  const canonicalWorldView = canonicalWorldViewDockPath(requestUrl.pathname, requestUrl.search);
  if (canonicalWorldView) {
    t.done(slowThresholdSeconds);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(canonicalWorldView);
  }

  // Same shape, for the three retired credential views (environment /
  // connections / api-keys → credentials/<subview>). Before the pointer is
  // parsed, so nothing downstream ever sees a retired viewType.
  const canonicalCredentials = canonicalCredentialsDockPath(requestUrl.pathname, requestUrl.search);
  if (canonicalCredentials) {
    t.done(slowThresholdSeconds);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(canonicalCredentials);
  }

  let dockForSetup: DockPointer | null = null;

  // URL-first tab materialization: the loader is the single writer, but it now
  // happens through setupTab so content setup has an explicit opening/opened
  // lifecycle and setup failures keep the visible tab with an error placeholder.
  if (viewType) {
    try {
      dockForSetup = DockPointer.fromUrl(`${requestUrl.pathname}${requestUrl.search}`);
    } catch {
      /* not a valid dock view — no tab */
    }
  }

  // The server declares which pages it serves (bootstrap `supported_pages`; the
  // local desktop server sends `["desk"]`). A dock URL naming an unsupported
  // page redirects to the first supported page's home. Placed before the branch
  // split so it covers both the root-dock and process-scoped paths; reads the
  // parsed pointer's `page` (NOT `params.viewType`, which binds a non-desk page
  // segment as the viewType). `bootstrapInfo` is ready — initSdk is awaited above.
  if (dockForSetup) {
    const pageRedirect = pageRedirectUrl(dockForSetup, dataContext.bootstrapInfo?.supported_pages, requestUrl.pathname);
    if (pageRedirect) {
      t.done(slowThresholdSeconds);
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(pageRedirect);
    }
  }

  // A dock whose scope pins a project that no longer exists is repaired here —
  // BEFORE setupTab tries (and fails) to materialize a tab keyed by that scope.
  if (dockForSetup) {
    await repairUnsatisfiableScope(dockForSetup, requestUrl.pathname);
  }

  if (!processId && !viewType && /^\/dock\/?$/.test(requestUrl.pathname)) {
    // Bare /dock has no child route to render; send it to the app root instead.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/');
  }

  // Handle session context — set process in dataContext (no agent required).
  if (viewType === ViewType.SESSION) {
    const sessionProcessId = pointer;

    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProcessTypeId,
      sessionProcessId ? new TypeId(AgenticProcess.type, sessionProcessId) : null,
    );

    if (sessionProcessId) {
      await dataContext.setActiveEntityTypeId(new TypeId(AgenticProcess.type, sessionProcessId));
      const process = await AgenticProcess.getById(sessionProcessId).catch(() => null);
      if (process?.project_id) {
        await loadProject(new TypeId(Project.type, process.project_id)).catch(() =>
          systemTools.resolveProjectContext(process.workdir, process),
        );
      } else {
        // Global (projectless) session — a workdir match adopts it into a project;
        // otherwise resolveProjectContext clears the active project to null (the
        // Global scope).
        await systemTools.resolveProjectContext(process?.workdir, process ?? undefined);
      }
    }

    // Session view doesn't require agent — just ensure compute node and return.
    await ensureComputeNodeLoaded();
    if (dockForSetup) await setupTabAndAdopt(dockForSetup);
    t.time('ensureComputeNode');
    t.done(slowThresholdSeconds);
    return;
  }

  if (!processId) {
    // Project is already loaded by initSdk -> setupProject, just ensure compute node.
    await ensureComputeNodeLoaded();
    t.time('ensureComputeNode');
    if (dockForSetup) {
      redirectLegacyAssetFsDock(dockForSetup, requestUrl.pathname);
    }
    let setupHandled = false;

    const runSetup = async (setupContent: () => Promise<string>) => {
      setupHandled = true;
      let label = 'loadDockPointer';
      const wrappedSetup = async () => {
        label = await setupContent();
      };
      // Timed: tab materialization gates the URL commit, so a slow ensure-tab
      // is felt as a slow navigation.
      if (dockForSetup)
        await perfTime('setupTabAndAdopt', () => setupTabAndAdopt(dockForSetup, { setupContent: wrappedSetup }));
      else await wrappedSetup();
      t.time(label);
    };

    if (dockForSetup) {
      const dock = dockForSetup;
      await runSetup(() => loadDockPointer(dock, { requestPath: requestUrl.pathname }));
      if (dock.viewType === ViewType.PROJECT) {
        const loadRedirect = await runLoadRedirects(args.request);
        if (loadRedirect) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw loadRedirect;
        }
      }
    }

    if (dockForSetup && !setupHandled) {
      await setupTabAndAdopt(dockForSetup);
    }

    t.done(slowThresholdSeconds);
    return;
  }

  // The legacy /agent/:agentId/flow/:processId family is gone — every live
  // route returns inside the !processId branch above. Defensive no-op.
  t.done(slowThresholdSeconds);
}
