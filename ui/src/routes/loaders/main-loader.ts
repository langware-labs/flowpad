/**
 * react-router loader entry for the agent app routes (/dock/*, /flow/*).
 *
 * This module is the dispatcher: it initialises the SDK, resolves the
 * compute node, and hands off to view-specific loaders based on `params.viewType`.
 * Shell/process loading lives in `./load-shell` and `./load-process`.
 */

import {
  cloudManager,
  ContextEntitiesEnum,
  dataContext,
  initSdk,
  isBackendUnreachable,
  Project,
  toplog,
  TypeId,
} from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation';
import { pageRedirectUrl } from '@src/navigation/supported-pages';
import { setupTabAndAdopt } from '@src/tabs/tab-content-lifecycle';
import { projectScope } from '@src/lib/scope-filter';
import { ViewType } from '@src/types/ViewType';
import { TimeIt } from '@src/utils/timeit';
import { sinceTabSwitch } from '@src/navigation/tab-switch-state';
import { redirect, replace, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { ProjectLoadError, loadProject } from './load-project';
import { describeProcessStartError } from './load-process';
import { markPerfT0, perfLog, perfTime } from './_perf';
import { canonicalizeDockUrl } from './canonicalize';
import { adoptScopeProject, loadDockPointer } from './load-dock-pointer';
import { processRouteCarry, resolveShellRoute } from './load-shell';
import { runLoadRedirects } from './load-redirects';
import { getDockLoadError } from './dock-load-error-store';
import { rememberLastPlace } from '@src/tabs/last-tab-restore';
// Side-effect import: feature-owned redirect resolvers register themselves.
import '@src/journey/journey-load-redirect';
import '@src/agents/agent-auto-launch-redirect'; // after journeys: first redirect wins

// Re-export kept for existing consumers (unit tests import from here).
export { describeProcessStartError };

/**
 * Drop a dock's scope when the project it pins does not exist, by redirecting to
 * the SAME pointer with no scope keys.
 *
 * This runs before tab materialization on purpose, and only for a SCOPE-KEYED
 * dock (Assets, Explorer), whose tab identity IS its scope
 * (`tabHash` = `<viewType>|project:<id>`). Such a tab cannot be minted for a
 * project that isn't there, and the dock loader that still runs after the failed
 * mint cannot repair it either: scope adoption swallows the dead project, so the
 * browse views would render its zero rows as an ordinary empty list. Repairing
 * here, before materialization, also skips the tab round trips a dead scope would
 * otherwise spend. Docks whose identity ignores scope are
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
 * Give an unscoped Assets file URL the scope of the project that holds the file,
 * by redirecting to the SAME pointer scoped to that project.
 *
 * Assets is scope-keyed: its tab identity is the scope, and the backend stamps
 * the tab's project from that scope (`_pointer_scope_project`). An unscoped file
 * URL — the explorer, a terminal link, search — therefore lands on the global
 * `assets|all` tab, whose project is null, and the project-filtered strip hides
 * the very tab on screen ("html opens, yet no tab", 2026-10-02). The file's
 * project is a fact about the file, so it is resolved here, before the tab is
 * minted (I2), and carried into the URL where tab identity reads it.
 *
 * Resolved by PATH (deepest project mount holding the file, from the cached
 * project list), not by the file's entity: an unindexed type (`.html`) has no
 * entity at all, and a path lookup costs the loader no round trip. A file no
 * project holds stays unscoped — the global tab is right for it.
 */
async function scopeAssetFileToItsProject(dock: DockPointer, requestPath: string): Promise<void> {
  if (dock.viewType !== ViewType.ASSETS || dock.scopeFilter || dock.isActiveDisplay || isHubOnly()) return;
  const machinePath = dock.vfsPath?.machinePath;
  if (!machinePath) return;
  const project = await Project.getProjectByPath(machinePath);
  if (!project) return;
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw replace(dock.withScopeFilter(projectScope(project.id)).toUrl(requestPath));
}

/**
 * Ensure compute node is loaded for the current project.
 * The route loader owns project selection; initSdk only caches the default.
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

/**
 * The dock loader, with its outcome on the `tab_switch` trail: one line per run —
 * `loader` (resolved), `loader_redirect` (a thrown redirect Response) or
 * `loader_error` — carrying the loader's own `ms` next to the switch's `+ms`.
 * A run with no switch before it is a revalidation (search-param write, etc.).
 */
export async function loadAgentApp(args: LoaderArgs) {
  // Timed unconditionally and checked at log time: on a cold page load the
  // loader starts before toplog has fetched its state.
  const started = performance.now();
  const kind = args.params.viewType ?? '-';
  try {
    const result = await loadAgentAppBody(args);
    if (toplog.isOn('tab_switch')) {
      toplog.log(
        'tab_switch',
        `loader ${sinceTabSwitch()} kind=${kind} ms=${Math.round(performance.now() - started)} path=${new URL(args.request.url).pathname}`,
      );
    }
    return result;
  } catch (err) {
    if (!toplog.isOn('tab_switch')) throw err;
    const ms = Math.round(performance.now() - started);
    if (err instanceof Response) {
      toplog.log(
        'tab_switch',
        `loader_redirect ${sinceTabSwitch()} kind=${kind} ms=${ms} status=${err.status} to=${err.headers.get('Location') ?? '-'}`,
      );
    } else {
      toplog.log('tab_switch', `loader_error ${sinceTabSwitch()} kind=${kind} ms=${ms} err:`, err);
    }
    throw err;
  }
}

async function loadAgentAppBody(args: LoaderArgs) {
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
    // `popup: false` — this load is being HALTED on the promise below, so the
    // page has nothing left to show. A popup would leave that dead load on
    // screen behind a window the user did not ask for; the navigation is what
    // the comment below promises and what this caller is committed to.
    void cloudManager.login({ popup: false });
    // Halt this load — the browser is navigating away.
    return await new Promise<never>(() => {});
  }

  const { processId, viewType } = params;

  // CANONICALIZE (dock-loading step 2): every URL-only rewrite, composed, so a
  // URL needing several still redirects once — before the pointer is parsed, so
  // nothing downstream ever sees a retired spelling.
  const canonical = canonicalizeDockUrl(requestUrl.pathname, requestUrl.search);
  if (canonical) {
    t.done(slowThresholdSeconds);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(canonical);
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

  if (!processId) {
    // The SDK seeds the compute node; the dock loader resolves its project.
    await ensureComputeNodeLoaded();
    t.time('ensureComputeNode');
    if (dockForSetup) {
      redirectLegacyAssetFsDock(dockForSetup, requestUrl.pathname);
      // RESOLVE (dock-loading step 3): identity redirects before a tab is minted
      // for a URL the loader is about to leave (I2) — an Assets file takes its
      // project's scope; a shell URL its scope, a dead process's sibling, or the
      // owning process's scoped URL.
      await scopeAssetFileToItsProject(dockForSetup, requestUrl.pathname);
      if (DockPointer.isSessionView(dockForSetup.viewType)) {
        await resolveShellRoute(dockForSetup.pointer, requestUrl.pathname, processRouteCarry(dockForSetup));
      }
      // Step 4: commit the URL's project for every view, ahead of tab
      // materialization and the per-view loader, so a switch lands even when
      // either fails (the error renders in the project being entered). An
      // entity-owned dock's loader still runs after and its project wins.
      if (dockForSetup.scopeProjectId) await adoptScopeProject(dockForSetup);
    }
    let setupHandled = false;

    const runSetup = async (setupContent: () => Promise<string>) => {
      setupHandled = true;
      let label = 'loadDockPointer';
      // Two spans, not one. `t.time()` records elapsed-since-the-last-mark, so
      // stamping only at the end attributed the WHOLE of `setupTabAndAdopt` —
      // three serial tab round-trips — to a bucket named after the loader that
      // runs inside it. A 4816ms cold open was reported as
      // `loadDockPointer:data-sources` when that switch has no case for
      // data-sources at all and awaits nothing. Close the materialization span
      // as the content callback opens, so each name means what it says.
      let materializationTimed = false;
      const wrappedSetup = async () => {
        if (dockForSetup) {
          t.time('setupTabAndAdopt');
          materializationTimed = true;
        }
        label = await setupContent();
      };
      // Timed: tab materialization gates the URL commit, so a slow ensure-tab
      // is felt as a slow navigation.
      if (dockForSetup)
        await perfTime('setupTabAndAdopt', () => setupTabAndAdopt(dockForSetup, { setupContent: wrappedSetup }));
      else await wrappedSetup();
      // A throw before the callback ran would otherwise leave the slow table
      // empty — the one case where you most want to see where the time went.
      if (dockForSetup && !materializationTimed) t.time('setupTabAndAdopt (failed)');
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

    // The place a launch reopens — unless this load rendered an error.
    if (dockForSetup && !getDockLoadError(dockForSetup)) {
      rememberLastPlace(dockForSetup, `${requestUrl.pathname}${requestUrl.search}`);
    }

    t.done(slowThresholdSeconds);
    return;
  }

  // The legacy /agent/:agentId/flow/:processId family is gone — every live
  // route returns inside the !processId branch above. Defensive no-op.
  t.done(slowThresholdSeconds);
}
