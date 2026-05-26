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
  QueryRequest,
  systemTools,
  Trigger,
  TypeId,
} from '@sdk';
import { DockPointer } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { TimeIt } from '@src/utils/timeit';
import { redirect, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { getBrokenViewUrl, loadFlowFromParams } from './loaders';
import { loadShellRoute, resolveDefaultTab } from './load-shell';
import { loadProject, loadProjectRoute } from './load-project';
import { loadConversationRoute } from './load-conversation';
import { loadTasksRoute } from './load-tasks';
import { describeProcessStartError } from './load-process';

// Re-exports kept for existing consumers (unit tests import from here).
export { resolveDefaultTab, describeProcessStartError };

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

function _perfLog(label: string) {
  const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
  if (t0 !== undefined) console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label}`);
}

export async function loadAgentApp(args: LoaderArgs) {
  const { params } = args;
  const requestUrl = new URL(args.request.url);
  const t = new TimeIt(`loadAgentApp(${params['*'] || params.viewType || '/'})`);
  _perfLog(`loadAgentApp start (${params['*'] || params.viewType || '?'})`);

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
        await loadProject(process.project_id).catch(() =>
          systemTools.resolveProjectContext(process.workdir, process),
        );
      } else {
        await systemTools.resolveProjectContext(process?.workdir, process ?? undefined);
      }
    }

    // Session view doesn't require agent — just ensure compute node and return.
    await ensureComputeNodeLoaded();
    t.time('ensureComputeNode');
    t.done(1.2);
    return;
  }

  if (!processId) {
    // Project is already loaded by initSdk -> setupProject, just ensure compute node.
    await ensureComputeNodeLoaded();
    t.time('ensureComputeNode');

    if (viewType === ViewType.SHELL) {
      await loadShellRoute(pointer || undefined);
      t.time('loadShellRoute');
    }

    if (viewType === ViewType.PROJECT) {
      await loadProjectRoute(pointer || undefined);
      t.time('loadProjectRoute');
    }

    if (viewType === ViewType.CONVERSATION) {
      await loadConversationRoute(pointer || undefined);
      t.time('loadConversationRoute');
    }

    if (viewType === ViewType.TASKS) {
      await loadTasksRoute(pointer || undefined);
      t.time('loadTasksRoute');
    }

    if (viewType === ViewType.TRIGGERS) {
      await Trigger.query(new QueryRequest({ type: Trigger.type, scope: [] }));
      t.time('loadTriggers');
    }

    if (viewType === ViewType.PLAN && pointer) {
      const parsed = DockPointer.parsePlanPointer(pointer);
      if (parsed) {
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, parsed.agenticProcessTypeId);
        const process = await AgenticProcess.getById(parsed.agenticProcessTypeId.id).catch(() => null);
        if (process?.project_id) {
          await loadProject(process.project_id).catch(() =>
            systemTools.resolveProjectContext(process.workdir, process),
          );
        } else {
          await systemTools.resolveProjectContext(process?.workdir, process ?? undefined);
        }
        t.time('loadPlan (set process context)');
      }
    }

    t.done(1.2);
    return;
  }

  const dockViewType = getDockViewType(args);
  if (!dockViewType) {
    t.done(1.2);
    return loadFlowFromParams(args);
  }
  if (!isValidViewType(args)) {
    const brokenViewUrl = getBrokenViewUrl(args);
    console.error(`[LOADER] Invalid view type(${dockViewType}). Redirecting to default view URL:`, brokenViewUrl);
    t.done(1.2);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(brokenViewUrl);
  }
  t.done(1.2);
  return loadFlowFromParams(args);
}
