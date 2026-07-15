/**
 * Project dock loader for
 *   /dock/project/<projectId>[/collaboration_room/<roomId>[/tab/<typeid>]]
 *
 * Reuses the pure `loadProcess` / `loadShell` primitives from the shell
 * loaders so PTY attach + context setup is identical to the standard route.
 * Owns its own route policy: room-root URLs may redirect to the active tab;
 * typed failures become dock-load errors rendered inside the requested URL.
 */

import {
  AgenticProcess,
  CollaborationRoom,
  ContextEntitiesEnum,
  dataContext,
  dataManager,
  Project,
  Shell,
  TypeId,
} from '@sdk';
import { applyProjectViewMode } from '@src/contexts/view-mode-context';
import { DockPointer } from '@src/navigation';
import { resolveNextTab, tabTargetKey } from '@src/tabs/tab-candidates';
import { getTerminalTabsSnapshot } from '@src/tabs/useTabs';
import { redirect } from 'react-router';
import { describeProcessStartError, loadProcess, ProcessLoadError } from './load-process';
import { loadShell, ShellLoadError } from './load-shell';
import { loadConversation } from './load-conversation';
import { processLoadErrorToDockError } from './process-load-error-resolution';
import { DockLoadError } from './dock-load-error';
import { loadAssetRoute } from './load-asset';

function errorStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number }; status?: number } | null)?.response?.status
    ?? (error as { status?: number } | null)?.status;
}

function hasProjectTabSegment(pointer: string | undefined): boolean {
  const parts = pointer?.split('/').filter(Boolean) ?? [];
  return parts[1] === 'collaboration_room' && parts[3] === 'tab';
}

export class ProjectLoadError extends Error {
  readonly status = 404;

  constructor(
    readonly kind: 'not_found',
    readonly projectId: string,
    readonly cause?: unknown,
  ) {
    super(`project-load:${kind}`);
  }
}

function throwProjectRouteError(cause: unknown): never {
  const status = errorStatus(cause);
  if (cause instanceof ProjectLoadError || status === 404 || status === 403) {
    throw new DockLoadError(
      'project_not_found',
      'hard',
      {
        action: 'render_error',
        title: 'Project not found',
        message: "This project doesn't exist or is no longer available.",
      },
      'project',
      cause,
    );
  }
  throw new DockLoadError(
    'project_network_error',
    'soft',
    {
      action: 'render_error',
      title: 'Project unavailable',
      message: 'Could not load this project. Try again in a moment.',
      retryable: true,
    },
    'project',
    cause,
  );
}

function throwRoomLoadError(cause: unknown, roomId: string): never {
  const status = errorStatus(cause);
  if (status === 404 || status === 403) {
    throw new DockLoadError(
      'collaboration_room_not_found',
      'hard',
      {
        action: 'render_error',
        title: 'Room not found',
        message: 'This collaboration room no longer exists or is unavailable.',
      },
      'project',
      cause,
    );
  }
  throw new DockLoadError(
    'collaboration_room_network_error',
    'soft',
    {
      action: 'render_error',
      title: 'Room unavailable',
      message: `Could not load collaboration room ${roomId.slice(0, 8)}. Try again in a moment.`,
      retryable: true,
    },
    'project',
    cause,
  );
}

function throwShellTabLoadError(error: ShellLoadError): never {
  if (error.kind === 'not_found') {
    throw new DockLoadError(
      'shell_not_found',
      'hard',
      {
        action: 'render_error',
        title: 'Shell not found',
        message: 'This terminal no longer exists.',
      },
      'project',
      error,
    );
  }
  if (error.kind === 'error_status') {
    throw new DockLoadError(
      'shell_error_status',
      'hard',
      {
        action: 'render_error',
        title: 'Shell unavailable',
        message: error.errorMessage ?? 'Shell error',
      },
      'project',
      error,
    );
  }
  const { title, description } = describeProcessStartError(error.cause ?? error);
  throw new DockLoadError(
    'shell_start_failed',
    'soft',
    {
      action: 'render_error',
      title,
      message: description,
      retryable: true,
    },
    'project',
    error,
  );
}

/**
 * Load a Project by id: fetch the entity via dataManager and write
 * `CurrentProjectTypeId` into context. Nothing else.
 *
 * This is the URL-first project primitive: every loader that lands on an
 * entity owned by a project (shell, agentic_process, conversation, plan, …)
 * must call this before any runtime side effect, so `dataContext.project`
 * reflects the URL-resolved owner — not whatever was active before.
 *
 * Throws if the project can't be fetched. Callers decide how to recover
 * (e.g. process.recoverProject() for dangling project_id refs).
 */
export async function loadProject(projectTypeId: TypeId): Promise<Project> {
  let project: Project | null = null;
  try {
    project = await dataManager.getByTypeId<Project>(projectTypeId);
  } catch (cause) {
    const status = errorStatus(cause);
    if (status === 404 || status === 403) {
      throw new ProjectLoadError('not_found', projectTypeId.id, cause);
    }
    throw cause;
  }
  if (!project) {
    throw new ProjectLoadError('not_found', projectTypeId.id);
  }
  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProjectTypeId,
    projectTypeId,
  );
  // Per-project view-mode memory: apply the project's remembered mode (or stamp
  // the current one onto a project that has none). After the context write, so
  // dataContext.project is this project before any recording. Synchronous apart
  // from fire-and-forget saves — the loader stays fast.
  applyProjectViewMode(project);
  return project;
}

/**
 * After the shell is loaded, stamp it with the owning room id so the
 * room-scoped tabs-store filter picks it up. `loadProcess`
 * creates a fresh Shell on reload (old PTY gone), so we can't rely on the
 * tag being persisted at tab-creation time.
 */
async function tagShellWithRoom(shell: Shell, roomId: string): Promise<void> {
  if (shell.collaboration_room_id === roomId) return;
  try {
    shell.collaboration_room_id = roomId;
    await shell.save();
  } catch (err) {
    console.warn('[load-project] failed to tag shell with room id', err);
  }
}

export async function loadProjectRoute(
  pointer: string | undefined,
  opts: { viewMode?: string | null } = {},
): Promise<void> {
  const { projectTypeId, roomId, tabTypeId, conversationId } =
    DockPointer.parseProjectPointer(pointer);
  const { assetSubPointer } = DockPointer.splitProjectPointer(pointer);
  const hasTabSegment = hasProjectTabSegment(pointer);
  if (!projectTypeId) {
    // No project id in URL — page renders its empty state; nothing to load.
    return;
  }

  // `/dock/project/<id>` means "show the project space" — in EVERY view mode.
  // This loader used to rewrite a bare project dock into the project's process
  // shell whenever the AMBIENT mode was Vibe, which hijacked the footer/rail
  // "open project view" controls: they ask for the project space by id and got
  // an agentic process instead. Entering a Vibe WORKSPACE is a CALLER intent and
  // is spelled out in the URL the caller navigates to — `open-project-component`
  // resolves a Vibe project-open to a shell itself — never re-decided here from
  // ambient state. URL-first: the loader loads what the URL names.

  // Prefetch project + room into the entity cache so the page's `useEntity`
  // calls hit immediately (no render blank → re-render).
  let project: Project | null = null;
  try {
    project = await loadProject(projectTypeId);
  } catch (cause) {
    throwProjectRouteError(cause);
  }

  if (project?.fs_storage_mount_path) {
    dataContext.setWorkdir(project.fs_storage_mount_path);
  }

  if (conversationId) {
    await loadConversation(conversationId).catch(() => null);
    await dataContext.setActiveEntityTypeId(projectTypeId);
  }

  if (!conversationId && !roomId && assetSubPointer) {
    await loadAssetRoute(assetSubPointer);
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      projectTypeId,
    );
  }

  if (roomId) {
    let room: CollaborationRoom | null = null;
    try {
      room = await dataManager.getByTypeId<CollaborationRoom>(
        new TypeId(CollaborationRoom.type, roomId),
      );
    } catch (cause) {
      throwRoomLoadError(cause, roomId);
    }
    if (!room) {
      throwRoomLoadError({ status: 404 }, roomId);
    }
  }

  if (!tabTypeId && hasTabSegment) {
    throw new DockLoadError(
      'malformed_project_tab',
      'hard',
      {
        action: 'render_error',
        title: 'Unsupported tab',
        message: 'This project tab URL is malformed.',
      },
      'project',
    );
  }

  if (!tabTypeId) {
    // No tab in the URL. If the room already has visible tabs, redirect
    // into the previously-active / first one so the xterm pane isn't blank.
    if (roomId) {
      // Room membership lives on the backing shell (`collaboration_room_id`),
      // which isn't denormalized on the Tab — resolve it from cache: a shell tab's
      // own shell, a process tab's linked shell.
      const allTabs = await getTerminalTabsSnapshot('all');
      const tabs = allTabs.filter((t) => {
        const shellId =
          t.target_type === AgenticProcess.type
            ? AgenticProcess.getByIdFromCache<AgenticProcess>(t.target_id ?? '')?.shell_id
            : t.target_id;
        const shell = shellId ? Shell.getByIdFromCache<Shell>(shellId) : null;
        return shell?.collaboration_room_id === roomId;
      });
      const tab = resolveNextTab(tabs);
      if (tab) {
        // The room-tab segment is the target TypeId string (shell-<id> /
        // agentic_process-<id>) — exactly `tabTargetKey`.
        const pointer = tabTargetKey(tab);
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect(`/dock/project/${projectTypeId.id}/collaboration_room/${roomId}/tab/${pointer}`);
      }
    }
    return;
  }

  if (tabTypeId.type === 'agentic_process') {
    try {
      const { shell } = await loadProcess(tabTypeId.id);
      if (roomId && shell) await tagShellWithRoom(shell, roomId);
    } catch (e) {
      if (!(e instanceof ProcessLoadError)) throw e;
      throw processLoadErrorToDockError(e, 'project');
    }
    return;
  }

  if (tabTypeId.type === 'shell') {
    try {
      const shell = await loadShell(tabTypeId.id);
      if (roomId) await tagShellWithRoom(shell, roomId);
    } catch (e) {
      if (!(e instanceof ShellLoadError)) throw e;
      throwShellTabLoadError(e);
    }
    return;
  }

  throw new DockLoadError(
    'unsupported_project_tab',
    'hard',
    {
      action: 'render_error',
      title: 'Unsupported tab',
      message: `Project tabs cannot load ${tabTypeId.type}.`,
    },
    'project',
  );
}
