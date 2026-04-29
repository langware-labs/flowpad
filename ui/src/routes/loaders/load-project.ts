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
  CollaborationRoom,
  dataManager,
  Project,
  type Shell,
  TypeId,
} from '@sdk';
import { filterTabs } from '@src/hooks/useActiveTerminals';
import { toast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation';
import { redirect } from 'react-router';
import { describeProcessStartError, loadProcess, ProcessLoadError } from './load-process';
import { fetchShellsAndProcesses, loadShell, resolveDefaultTab, ShellLoadError } from './load-shell';

function recoveryUrl(projectId: string, roomId: string | null): string {
  return roomId
    ? `/dock/project/${projectId}/collaboration_room/${roomId}`
    : `/dock/project/${projectId}`;
}

/**
 * After the shell is loaded, stamp it with the owning room id so the
 * room-scoped `useActiveTerminals` filter picks it up. `loadProcess`
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
  const { projectId, roomId, tabTypeId } = DockPointer.parseProjectPointer(pointer);
  if (!projectId) {
    // No project id in URL — page renders its empty state; nothing to load.
    return;
  }

  // Prefetch project + room into the entity cache so the page's `useEntity`
  // calls hit immediately (no render blank → re-render).
  try {
    await dataManager.getByTypeId(new TypeId(Project.type, projectId));
  } catch {
    // Missing project — let the page's own fallback (Loading… / EmptyState) handle it.
    return;
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
      const [shells, processes] = await fetchShellsAndProcesses();
      const tabs = filterTabs(shells, processes, { visible: true, collaborationRoomId: roomId });
      const tab = resolveDefaultTab(tabs);
      if (tab) {
        const pointer = (tab.agenticProcess ?? tab.shell!).dockPointer.pointer;
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
      if (e.kind === 'not_found') {
        toast({
          title: 'Session not found',
          description: 'Agentic process does not exist.',
          variant: 'destructive',
        });
      } else if (e.kind === 'start_failed') {
        toast({ ...describeProcessStartError(e.cause ?? e), variant: 'destructive' });
      } else {
        toast({
          title: 'Session unavailable',
          description: 'No shell is linked to this process.',
          variant: 'destructive',
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
        toast({
          title: 'Shell not found',
          description: 'This terminal no longer exists.',
          variant: 'destructive',
        });
      } else if (e.kind === 'error_status') {
        toast({
          title: 'Shell unavailable',
          description: e.errorMessage ?? 'Shell error',
          variant: 'destructive',
        });
      } else {
        toast({ ...describeProcessStartError(e.cause ?? e), variant: 'destructive' });
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
