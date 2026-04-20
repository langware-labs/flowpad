/**
 * Project dock loader for
 *   /dock/project/<projectId>[/collaborative_session/<sessionId>[/tab/<typeid>]]
 *
 * Reuses the pure `loadProcess` / `loadShell` primitives from the shell
 * loaders so PTY attach + context setup is identical to the standard route.
 * Owns its own redirect URL policy — failures bounce to the collaborative
 * session (or project root) inside the same view, not out to /dock/shell.
 */

import {
  CollaborationSession,
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
import { emptyRecoverySkips, type ShellRecoverySkips } from './shell-recovery';

function recoveryUrl(projectId: string, sessionId: string | null): string {
  return sessionId
    ? `/dock/project/${projectId}/collaborative_session/${sessionId}`
    : `/dock/project/${projectId}`;
}

/**
 * After the shell is loaded, stamp it with the owning session id so the
 * session-scoped `useActiveTerminals` filter picks it up. `loadProcess`
 * creates a fresh Shell on reload (old PTY gone), so we can't rely on the
 * tag being persisted at tab-creation time.
 */
async function tagShellWithSession(shell: Shell, sessionId: string): Promise<void> {
  if (shell.collaboration_session_id === sessionId) return;
  try {
    shell.collaboration_session_id = sessionId;
    await shell.save();
  } catch (err) {
    console.warn('[load-project] failed to tag shell with session id', err);
  }
}

export async function loadProjectRoute(
  pointer: string | undefined,
  _recoverySkips: ShellRecoverySkips = emptyRecoverySkips(),
): Promise<void> {
  const { projectId, sessionId, tabTypeId } = DockPointer.parseProjectPointer(pointer);
  if (!projectId) {
    // No project id in URL — page renders its empty state; nothing to load.
    return;
  }

  // Prefetch project + session into the entity cache so the page's `useEntity`
  // calls hit immediately (no render blank → re-render).
  try {
    await dataManager.getByTypeId(new TypeId(Project.type, projectId));
  } catch {
    // Missing project — let the page's own fallback (Loading… / EmptyState) handle it.
    return;
  }

  if (sessionId) {
    try {
      await dataManager.getByTypeId(new TypeId(CollaborationSession.type, sessionId));
    } catch {
      // Missing session — bounce to the project's collaboration root.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl(projectId, null));
    }
  }

  if (!tabTypeId) {
    // No tab in the URL. If the session already has visible tabs, redirect
    // into the previously-active / first one so the xterm pane isn't blank.
    if (sessionId) {
      const [shells, processes] = await fetchShellsAndProcesses();
      const tabs = filterTabs(shells, processes, { visible: true, collaborationSessionId: sessionId });
      const tab = resolveDefaultTab(tabs);
      if (tab) {
        const pointer = (tab.agenticProcess ?? tab.shell!).dockPointer.pointer;
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect(`/dock/project/${projectId}/collaborative_session/${sessionId}/tab/${pointer}`);
      }
    }
    return;
  }

  if (tabTypeId.type === 'agentic_process') {
    try {
      const { shell } = await loadProcess(tabTypeId.id);
      if (sessionId) await tagShellWithSession(shell, sessionId);
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
      throw redirect(recoveryUrl(projectId, sessionId));
    }
    return;
  }

  if (tabTypeId.type === 'shell') {
    try {
      const shell = await loadShell(tabTypeId.id);
      if (sessionId) await tagShellWithSession(shell, sessionId);
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
      throw redirect(recoveryUrl(projectId, sessionId));
    }
    return;
  }

  // Unknown tab type: fall back to the session root — tolerant parsing.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect(recoveryUrl(projectId, sessionId));
}
