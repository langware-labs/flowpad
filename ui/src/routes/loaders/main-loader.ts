/**
 * react-router loader entry for the agent app routes (/dock/*, /flow/*).
 *
 * This module is the dispatcher: it initialises the SDK, resolves the
 * compute node, and hands off to view-specific loaders based on `params.viewType`.
 * Shell/process loading lives in `./load-shell` and `./load-process`.
 */

import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  initSdk,
  Project,
  systemTools,
  TypeId,
} from '@sdk';
import { DockPointer } from '@src/navigation';
import { applyAllTabs } from '@src/tabs/all-tabs-store';
import { setupTab } from '@src/tabs/tab-lifecycle';
import { ViewType } from '@src/types/ViewType';
import { TimeIt } from '@src/utils/timeit';
import { redirect, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { getBrokenViewUrl, loadFlowFromParams } from './loaders';
import { loadProject } from './load-project';
import { describeProcessStartError } from './load-process';
import { markPerfT0, perfLog } from './_perf';
import { loadDockPointer } from './load-dock-pointer';

// Re-export kept for existing consumers (unit tests import from here).
export { describeProcessStartError };

const ALLOWED_VIEWS = new Set(Object.values(ViewType));

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

async function setupTabAndAdopt(
  dock: DockPointer,
  options?: Parameters<typeof setupTab>[1],
): Promise<void> {
  const onMaterialized = options?.onMaterialized;
  let adoptedMaterializedTabs = false;
  const result = await setupTab(dock, {
    ...options,
    onMaterialized: (tabs) => {
      adoptedMaterializedTabs = true;
      onMaterialized?.(tabs);
      applyAllTabs(tabs);
    },
  });
  if (!adoptedMaterializedTabs && result.tabs && result.tabs.length > 0) {
    applyAllTabs(result.tabs);
  }
}

function isValidViewType(args: LoaderArgs): boolean {
  const { viewType } = args.params;
  if (!viewType) return false;
  const v = String(viewType ?? '').toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ALLOWED_VIEWS.has(v as any);
}

function getDockViewType(args: LoaderArgs): ViewType | undefined {
  if (!isValidViewType(args)) return undefined;
  const v = String(args.params.viewType ?? '').toLowerCase();
  return v as ViewType;
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
  await initSdk(params);
  t.time('initSdk');

  // Check if service is unavailable - throw error so ErrorBoundary catches it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrapError = dataContext.bootstrapError as any;
  if (bootstrapError?.isServiceUnavailable || bootstrapError?.type === 'network') {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw dataContext.bootstrapError;
  }

  const { processId, viewType } = params;
  const pointer = params['*'] || '';
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
        await loadProject(new TypeId(Project.type, process.project_id)).catch(() => systemTools.resolveProjectContext(process.workdir, process));
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
    let setupHandled = false;

    const runSetup = async (setupContent: () => Promise<string>) => {
      setupHandled = true;
      let label = 'loadDockPointer';
      const wrappedSetup = async () => {
        label = await setupContent();
      };
      if (dockForSetup) await setupTabAndAdopt(dockForSetup, { setupContent: wrappedSetup });
      else await wrappedSetup();
      t.time(label);
    };

    if (dockForSetup) {
      const dock = dockForSetup;
      await runSetup(() => loadDockPointer(dock, { requestPath: requestUrl.pathname }));
    }

    if (dockForSetup && !setupHandled) {
      await setupTabAndAdopt(dockForSetup);
    }

    t.done(slowThresholdSeconds);
    return;
  }

  const dockViewType = getDockViewType(args);
  if (!dockViewType) {
    t.done(slowThresholdSeconds);
    return loadFlowFromParams(args);
  }
  if (!isValidViewType(args)) {
    const brokenViewUrl = getBrokenViewUrl(args);
    console.error(`[LOADER] Invalid view type(${dockViewType}). Redirecting to default view URL:`, brokenViewUrl);
    t.done(slowThresholdSeconds);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(brokenViewUrl);
  }
  t.done(slowThresholdSeconds);
  return loadFlowFromParams(args);
}
