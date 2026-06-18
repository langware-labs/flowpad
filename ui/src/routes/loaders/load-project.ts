/**
 * Project dock loader for
 *   /dock/project/<projectId>[/collaboration_room/<roomId>[/tab/<typeid>]]
 *
 * Reuses the pure `loadProcess` / `loadShell` primitives from the shell
 * loaders so PTY attach + context setup is identical to the standard route.
 * Owns its own redirect URL policy — failures bounce to the collaboration
 * room (or project root) inside the same view, not out to /dock/shell.
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
import { getTerminalTabsSnapshot } from '@src/tabs/useTabs';
import { notify } from '@src/notifications';
import { DockPointer } from '@src/navigation';
import { redirect } from 'react-router';
import { describeProcessStartError, loadProcess, ProcessLoadError } from './load-process';

/** Map the `{ title, description }` shape from `describeProcessStartError`
 *  onto the unified notify error payload. */
function notifyProcessStartError(error: unknown): void {
  const { title, description } = describeProcessStartError(error);
  notify.error({ title, message: description });
}
import { resolveNextTab, tabTargetKey } from '@src/tabs/tab-candidates';
import { loadShell, ShellLoadError } from './load-shell';
import { loadConversation } from './load-conversation';

function recoveryUrl(projectId: string, roomId: string | null): string {
  return roomId
    ? `/dock/project/${projectId}/collaboration_room/${roomId}`
    : `/dock/project/${projectId}`;
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
export async function loadProject(projectId: string): Promise<Project> {
  const project = await dataManager.getByTypeId<Project>(
    new TypeId(Project.type, projectId),
  );
  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProjectTypeId,
    new TypeId(Project.type, projectId),
  );
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

export async function loadProjectRoute(pointer: string | undefined): Promise<void> {
  const parsed = DockPointer.parseProjectPointer(pointer) as {
    projectId: string | null;
    roomId: string | null;
    tabTypeId: TypeId | null;
    conversationId?: string | null;
  };
  const { projectId, roomId, tabTypeId } = parsed;
  const conversationId = parsed.conversationId ?? null;
  if (!projectId) {
    // No project id in URL — page renders its empty state; nothing to load.
    return;
  }

  // Prefetch project + room into the entity cache so the page's `useEntity`
  // calls hit immediately (no render blank → re-render).
  let project: Project | null = null;
  try {
    project = await loadProject(projectId);
  } catch {
    notify.error({
      title: 'Project not found',
      message: "This project doesn't exist or is no longer available.",
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/');
  }

  if (project?.fs_storage_mount_path) {
    dataContext.setWorkdir(project.fs_storage_mount_path);
  }

  if (conversationId) {
    try {
      await loadConversation(conversationId);
    } catch {
    }
    await dataContext.setActiveEntityTypeId(new TypeId(Project.type, projectId));
  }

  if (roomId) {
    try {
      await dataManager.getByTypeId(new TypeId(CollaborationRoom.type, roomId));
    } catch {
      // Missing room — bounce to the project's collaboration root.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl(projectId, null));
    }
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
        throw redirect(`/dock/project/${projectId}/collaboration_room/${roomId}/tab/${pointer}`);
      }
    }
    return;
  }

  if (tabTypeId.type === 'agentic_process') {
    try {
      const { shell } = await loadProcess(tabTypeId.id);
      if (roomId) await tagShellWithRoom(shell, roomId);
    } catch (e) {
      if (!(e instanceof ProcessLoadError)) throw e;
      if (e.kind === 'entity_not_found') {
        notify.error({
          title: 'Session not found',
          message: 'Agentic process does not exist.',
        });
      } else if (e.kind === 'network_error') {
        notify.error({
          title: 'Couldn’t reach backend',
          message: 'Try again in a moment.',
        });
      } else if (
        e.kind === 'runtime_terminated' ||
        e.kind === 'pty_attach_failed'
      ) {
        notifyProcessStartError(e.cause ?? e);
      } else {
        notify.error({
          title: 'Session unavailable',
          message: 'No shell is linked to this process.',
        });
      }
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl(projectId, roomId));
    }
    return;
  }

  if (tabTypeId.type === 'shell') {
    try {
      const shell = await loadShell(tabTypeId.id);
      if (roomId) await tagShellWithRoom(shell, roomId);
    } catch (e) {
      if (!(e instanceof ShellLoadError)) throw e;
      if (e.kind === 'not_found') {
        notify.error({
          title: 'Shell not found',
          message: 'This terminal no longer exists.',
        });
      } else if (e.kind === 'error_status') {
        notify.error({
          title: 'Shell unavailable',
          message: e.errorMessage ?? 'Shell error',
        });
      } else {
        notifyProcessStartError(e.cause ?? e);
      }
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl(projectId, roomId));
    }
    return;
  }

  // Unknown tab type: fall back to the room root — tolerant parsing.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect(recoveryUrl(projectId, roomId));
}
