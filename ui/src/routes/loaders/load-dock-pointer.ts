import { AgenticProcess, Plan, QueryRequest, Trigger, TypeId, VFSPath } from '@sdk';
import { redirect } from 'react-router';
import { DockPointer } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { clearDockLoadError } from './dock-load-error-store';
import { DockLoadError, handleDockLoadError } from './dock-load-error';
import { loadAssetRoute } from './load-asset';
import { loadConversationRoute } from './load-conversation';
import { loadLensRoute } from './load-lens';
import { loadProjectRoute } from './load-project';
import { loadProcess, ProcessLoadError } from './load-process';
import { loadShellRoute } from './load-shell';
import { loadTasksRoute } from './load-tasks';
import { processLoadErrorToDockError } from './process-load-error-resolution';

export interface DockLoaderContext {
  requestPath: string;
}

async function loadPlanRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) return;
  const parsed = DockPointer.parsePlanPointer(pointer);
  if (!parsed) return;

  // Legacy `agentic_process-<id>/<path>` form (old bookmarks): resolve the abs
  // path and redirect to the canonical, process-independent `vfs` form so the
  // view only ever sees the new grammar and the link self-heals on first open.
  if (parsed.kind === 'legacy') {
    throw redirect(`/dock/plan/${DockPointer.forPlanByPath(parsed.filePath).pointer}`);
  }

  // typeid form: the plan must resolve as a real entity, else render a clear
  // "not found" page (vs. an infinite spinner). The DockLoadErrorView shows it.
  if (parsed.kind === 'typeid') {
    const plan = await Plan.getById(parsed.planTypeId.id).catch(() => null);
    if (!plan) {
      throw new DockLoadError(
        'plan_not_found',
        'hard',
        {
          action: 'render_error',
          title: 'Plan not found',
          message: 'This plan no longer exists.',
        },
        'plan',
      );
    }
    return;
  }

  // vfs form: addressed by path on a (local) compute node — no entity required,
  // the view reads the file directly. Nothing to pre-resolve; `VFSPath.parse`
  // validates shape and the view surfaces a clear error if the file is missing.
  VFSPath.parse(parsed.vfsValue);
}

async function loadAgenticProcessRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) return;
  const processId = DockPointer.isAgenticProcessPointer(pointer)
    ? DockPointer.extractAgenticProcessId(pointer)
    : pointer;
  try {
    new TypeId(AgenticProcess.type, processId);
  } catch (error) {
    throw new DockLoadError(
      'malformed_session_pointer',
      'hard',
      {
        action: 'render_error',
        title: 'Session not found',
        message: 'This session URL is malformed or unavailable.',
      },
      'agentic_process',
      error,
    );
  }
  try {
    await loadProcess(processId);
  } catch (error) {
    if (error instanceof ProcessLoadError) {
      throw processLoadErrorToDockError(error, 'agentic_process');
    }
    throw error;
  }
}

export async function loadDockPointer(
  dock: DockPointer,
  context: DockLoaderContext,
): Promise<string> {
  const label = `loadDockPointer:${dock.viewType ?? 'unknown'}`;
  try {
    switch (dock.viewType) {
      case ViewType.SHELL:
        await loadShellRoute(dock.pointer, context.requestPath, { scope: dock.scopeFilter, viewMode: dock.viewMode });
        break;
      case ViewType.PROJECT:
        await loadProjectRoute(dock.pointer);
        break;
      case ViewType.CONVERSATION:
        await loadConversationRoute(dock.pointer);
        break;
      case ViewType.ASSETS:
        await loadAssetRoute(dock.pointer);
        break;
      case ViewType.TASKS:
        await loadTasksRoute(dock.pointer);
        break;
      case ViewType.AGENTIC_PROCESS:
        await loadAgenticProcessRoute(dock.pointer);
        break;
      case ViewType.TRIGGERS:
        await Trigger.query(new QueryRequest({ type: Trigger.type, scope: [] }));
        break;
      case ViewType.PLAN:
        await loadPlanRoute(dock.pointer);
        break;
      case ViewType.LENS:
        await loadLensRoute(dock.pointer);
        break;
      default:
        break;
    }
    clearDockLoadError(dock);
    return label;
  } catch (error) {
    handleDockLoadError(error, dock);
    return label;
  }
}
