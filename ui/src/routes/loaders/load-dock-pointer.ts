import {
  AgenticProcess,
  dataContext,
  isValidTag,
  PageId,
  Plan,
  Project,
  QueryRequest,
  RemoteWorkerSession,
  Trigger,
  TypeId,
  VFSPath,
} from '@sdk';
import { redirect } from 'react-router';
import { DockPointer } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { clearDockLoadError } from './dock-load-error-store';
import { DockLoadError, handleDockLoadError } from './dock-load-error';
import { loadAssetRoute } from './load-asset';
import { loadConversationRoute } from './load-conversation';
import { loadLensRoute } from './load-lens';
import { loadProject, loadProjectRoute } from './load-project';
import { loadProcess, ProcessLoadError } from './load-process';
import { loadShellRoute } from './load-shell';
import { loadTasksRoute } from './load-tasks';
import { processLoadErrorToDockError } from './process-load-error-resolution';

export interface DockLoaderContext {
  requestPath: string;
}

/**
 * Adopt the project pinned in a dock's scope filter into context. This is the
 * URL-first project write for CONTEXT-NEUTRAL docks — the scoped browse views
 * (assets list, explorer, desktop, triggers) whose loaders have no entity to
 * derive a project from. Without it, entering a project whose landing tab is
 * one of these views leaves `CurrentProjectTypeId` pointing at the PREVIOUS
 * project (the stuck-footer switch bug). Entity-backed docks keep their own
 * derivation: they run after this and their entity's project wins.
 * Best-effort — a missing project must not fail a browse landing.
 */
async function adoptScopeProject(dock: DockPointer): Promise<void> {
  const projectId = dock.scopeProjectId;
  if (!projectId || dataContext.project?.id === projectId) return;
  await loadProject(new TypeId(Project.type, projectId)).catch(() => {});
}

async function loadPlanRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) return;
  const parsed = DockPointer.parsePlanPointer(pointer);
  if (!parsed) return;

  // Legacy `agentic_process-<id>/<path>` form (old bookmarks): resolve the abs
  // path and redirect to the canonical, process-independent `vfs` form so the
  // view only ever sees the new grammar and the link self-heals on first open.
  if (parsed.kind === 'legacy') {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
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

function loadLiveSessionRoute(pointer: string | undefined): void {
  if (!pointer) return;
  // Identity validation only — the view watches the session entity live (a
  // guest-side DRAFT row may exist locally before anything is on the hub), so
  // the loader stays fast (no WS/PTY-bound work; see CLAUDE.md loader rule).
  try {
    new TypeId(RemoteWorkerSession.type, pointer);
  } catch (error) {
    throw new DockLoadError(
      'malformed_session_pointer',
      'hard',
      {
        action: 'render_error',
        title: 'Live session not found',
        message: 'This live-session URL is malformed or unavailable.',
      },
      'live_session',
      error,
    );
  }
}

/**
 * Validate a graph root and adopt it as the URL-owned active entity. This is
 * intentionally the loader's entire responsibility: graph reads happen in the
 * mounted view and cloud inventory sync is only triggered by its Sync button.
 */
export async function loadGraphIdentityRoute(dock: DockPointer, surface: 'graph' | 'worldview'): Promise<void> {
  try {
    if (surface === 'worldview') {
      if (!DockPointer.parseWorldViewProjection(dock.pointer)) {
        throw new Error('Expected a WorldView projection');
      }
      const focus = dock.options?.focus;
      await dataContext.setActiveEntityTypeId(focus ? new TypeId(focus) : null);
      return;
    }

    if (!dock.pointer) return;
    const parsed = DockPointer.parseGraphPointer(dock.pointer);
    if (!parsed) throw new Error('Expected <type>/<id>');
    await dataContext.setActiveEntityTypeId(new TypeId(parsed.type, parsed.id));
  } catch (error) {
    throw new DockLoadError(
      'malformed_graph_pointer',
      'hard',
      {
        action: 'render_error',
        title: surface === 'worldview' ? 'WorldView not found' : 'Graph root not found',
        message: `This ${surface === 'worldview' ? 'WorldView' : 'graph'} URL is malformed or unavailable.`,
      },
      surface,
      error,
    );
  }
}

/** `/dock/tag/graph[/<name>]` — shape check only (loaders stay near-empty). */
function loadTagRoute(dock: DockPointer): void {
  const parsed = DockPointer.parseTagPointer(dock.pointer);
  const tagName = parsed?.tag;
  if (!parsed || (tagName !== null && !isValidTag(tagName))) {
    throw new DockLoadError(
      'malformed_tag_pointer',
      'hard',
      {
        action: 'render_error',
        title: 'Tag view not found',
        message: 'Expected /dock/tag/graph or /dock/tag/graph/<dot.tag.name>.',
      },
      'tag',
    );
  }
}

/** `/dock/subgraph/<projection>[/<focusKey>]` — non-empty projection only. */
function loadSubgraphRoute(dock: DockPointer): void {
  if (!DockPointer.parseSubgraphPointer(dock.pointer)) {
    throw new DockLoadError(
      'malformed_subgraph_pointer',
      'hard',
      {
        action: 'render_error',
        title: 'Subgraph not found',
        message: 'Expected /dock/subgraph/<projection>.',
      },
      'subgraph',
    );
  }
}

export async function loadDockPointer(dock: DockPointer, context: DockLoaderContext): Promise<string> {
  const label = `loadDockPointer:${dock.viewType ?? 'unknown'}`;
  try {
    switch (dock.viewType) {
      case ViewType.SHELL:
        await loadShellRoute(dock.pointer, context.requestPath, {
          scope: dock.scopeFilter,
          viewMode: dock.viewMode,
        });
        break;
      case ViewType.PROJECT:
        await loadProjectRoute(dock.pointer, { viewMode: dock.viewMode });
        break;
      case ViewType.CONVERSATION:
        await loadConversationRoute(dock.pointer);
        break;
      case ViewType.ASSETS:
        await adoptScopeProject(dock);
        await loadAssetRoute(dock.pointer, {
          allowLocalWikiAlias: dock.page !== PageId.HUB,
          wikiAuthority: dock.page === PageId.HUB ? 'hub' : 'local',
        });
        break;
      case ViewType.TASKS:
        await loadTasksRoute(dock.pointer);
        break;
      case ViewType.AGENTIC_PROCESS:
        await loadAgenticProcessRoute(dock.pointer);
        break;
      case ViewType.LIVE_SESSION:
        loadLiveSessionRoute(dock.pointer);
        break;
      case ViewType.TRIGGERS:
        await adoptScopeProject(dock);
        await Trigger.query(new QueryRequest({ type: Trigger.type, scope: [] }));
        break;
      case ViewType.PLAN:
        await loadPlanRoute(dock.pointer);
        break;
      case ViewType.LENS:
        await loadLensRoute(dock.pointer);
        break;
      case ViewType.GRAPH:
        await loadGraphIdentityRoute(dock, 'graph');
        break;
      case ViewType.WORLDVIEW:
        await loadGraphIdentityRoute(dock, 'worldview');
        break;
      case ViewType.TAG:
        // URL-first + near-empty: validate shape only. NO entity resolution —
        // anonymous (ghost) tags are first-class in the tag graph.
        loadTagRoute(dock);
        break;
      case ViewType.SUBGRAPH:
        loadSubgraphRoute(dock);
        break;
      default:
        // Explorer, desktop, and other loader-less views: still honor a
        // project-pinned scope so a scoped browse landing switches the project.
        await adoptScopeProject(dock);
        break;
    }
    clearDockLoadError(dock);
    return label;
  } catch (error) {
    handleDockLoadError(error, dock);
    return label;
  }
}
