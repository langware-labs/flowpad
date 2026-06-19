import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  Project,
  QueryRequest,
  systemTools,
  Trigger,
  TypeId,
} from '@sdk';
import { DockPointer } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { clearDockLoadError } from './dock-load-error-store';
import { DockLoadError, handleDockLoadError } from './dock-load-error';
import { loadAssetRoute } from './load-asset';
import { loadConversationRoute } from './load-conversation';
import { loadProject, loadProjectRoute } from './load-project';
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

  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProcessTypeId,
    parsed.agenticProcessTypeId,
  );
  const process = await AgenticProcess.getById(parsed.agenticProcessTypeId.id).catch(() => null);
  if (process?.project_id) {
    await loadProject(new TypeId(Project.type, process.project_id)).catch(() =>
      systemTools.resolveProjectContext(process.workdir, process),
    );
  } else {
    await systemTools.resolveProjectContext(process?.workdir, process ?? undefined);
  }
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
        await loadShellRoute(dock.pointer, context.requestPath);
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
