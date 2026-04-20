/**
 * Collaboration-space dock loader for
 *   /dock/collaboration_space/<spaceId>[/session/<sessionId>[/tab/<typeid>]]
 *
 * Reuses the pure `loadProcess` / `loadShell` primitives from the shell
 * loaders so PTY attach + context setup is identical to the standard route.
 * Owns its own redirect URL policy — failures bounce to the session (or
 * space) root inside the same view, not out to /dock/shell.
 */

import {
  CollaborationSession,
  CollaborationSpace,
  dataManager,
  type Shell,
  TypeId,
} from '@sdk';
import { toast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation';
import { redirect } from 'react-router';
import { describeProcessStartError, loadProcess, ProcessLoadError } from './load-process';
import { loadShell, ShellLoadError } from './load-shell';
import { emptyRecoverySkips, type ShellRecoverySkips } from './shell-recovery';

function recoveryUrl(spaceId: string, sessionId: string | null): string {
  return sessionId
    ? `/dock/collaboration_space/${spaceId}/session/${sessionId}`
    : `/dock/collaboration_space/${spaceId}`;
}

/**
 * After the shell is loaded, stamp it with the owning space id so the space-
 * scoped `useActiveTerminals` filter picks it up. `loadProcess` creates a
 * fresh Shell on reload (old PTY gone), so we can't rely on the tag being
 * persisted at tab-creation time.
 */
async function tagShellWithSpace(shell: Shell, spaceId: string): Promise<void> {
  if (shell.collaboration_space_id === spaceId) return;
  try {
    shell.collaboration_space_id = spaceId;
    await shell.save();
  } catch (err) {
    console.warn('[load-space] failed to tag shell with space id', err);
  }
}

export async function loadCollaborationSpaceRoute(
  pointer: string | undefined,
  _recoverySkips: ShellRecoverySkips = emptyRecoverySkips(),
): Promise<void> {
  const { spaceId, sessionId, tabTypeId } = DockPointer.parseCollaborationSpacePointer(pointer);
  if (!spaceId) {
    // No space id in URL — page renders its empty state; nothing to load.
    return;
  }

  // Prefetch space + session into the entity cache so the page's `useEntity`
  // calls hit immediately (no render blank → re-render).
  try {
    await dataManager.getByTypeId(new TypeId(CollaborationSpace.type, spaceId));
  } catch {
    // Missing space — let the page's own fallback (Loading… / EmptyState) handle it.
    return;
  }

  if (sessionId) {
    try {
      await dataManager.getByTypeId(new TypeId(CollaborationSession.type, sessionId));
    } catch {
      // Missing session — bounce to the space root.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl(spaceId, null));
    }
  }

  if (!tabTypeId) {
    return;
  }

  if (tabTypeId.type === 'agentic_process') {
    try {
      const { shell } = await loadProcess(tabTypeId.id);
      await tagShellWithSpace(shell, spaceId);
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
      throw redirect(recoveryUrl(spaceId, sessionId));
    }
    return;
  }

  if (tabTypeId.type === 'shell') {
    try {
      const shell = await loadShell(tabTypeId.id);
      await tagShellWithSpace(shell, spaceId);
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
      throw redirect(recoveryUrl(spaceId, sessionId));
    }
    return;
  }

  // Unknown tab type: fall back to the session root — tolerant parsing.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect(recoveryUrl(spaceId, sessionId));
}
