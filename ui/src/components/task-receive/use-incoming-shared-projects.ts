import { gitOriginOf, isSafeRelPath, type GitOrigin } from '@sdk/models/GitOrigin';
import { useProjects } from '@src/hooks/use-projects';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { useEffect, useRef } from 'react';

/**
 * Offer to install a project somebody shared with you.
 *
 * When the hub grants membership it pushes the whole Project row and nothing
 * else: the recipient ends up with a project that has an `origin` but no files
 * and no local folder — a row that looks like a project and does nothing. The
 * clone that fixes it existed already (`setup-from-git`) but had no caller: it
 * was reachable only from the manual invitation-accept path, which the hub's
 * auto-accept skips entirely. So a shared project simply never arrived.
 *
 * This watches for exactly that shape and raises the existing "X shared a
 * project with you" dialog, whose Install button does the clone. Reading the
 * rows rather than hooking the push handler means it is also a catch-up: a
 * project granted while the app was closed is offered on the next start.
 *
 * Desktop only — installing writes files, and a hub-only runtime has nowhere to
 * put them. The caller decides that by not mounting this.
 */
/** A PROJECT's origin is the repository itself, so its `rel_path` is empty —
 *  `isCompleteGitOrigin` is the test for an ASSET *inside* a repo and rejects
 *  exactly the shape a shared project has. Only a path pointing outside the
 *  checkout is disqualifying here. */
function installableOrigin(o: GitOrigin | null): o is GitOrigin {
  return !!o && !!o.owner && !!o.name && (!o.rel_path || isSafeRelPath(o.rel_path));
}

export function useIncomingSharedProjects(): void {
  const setPendingProject = useIncomingProjectStore((s) => s.setPendingProject);
  const pendingProject = useIncomingProjectStore((s) => s.pendingProject);
  // One offer per project per session: a dismissed dialog must not reappear on
  // the next render, and a project mid-install must not be offered again.
  const handled = useRef<Set<string>>(new Set());

  // The canonical live collection, already warmed at startup — not a second
  // subscription over the same rows.
  const { projects } = useProjects();

  useEffect(() => {
    if (pendingProject) return; // one dialog at a time
    const waiting = (projects ?? []).find(
      (p) =>
        p.remote === true &&
        !p.fs_storage_mount_path &&
        !handled.current.has(p.id) &&
        // A git origin is what makes this installable. Projects shared through a
        // conversation carry no origin, and offering to install them would open
        // a dialog whose only outcome is an error.
        installableOrigin(gitOriginOf(p)),
    );
    const origin = gitOriginOf(waiting);
    if (!waiting || !origin) return;
    handled.current.add(waiting.id);
    setPendingProject({
      projectId: waiting.id,
      gitOrigin: origin,
      projectName: waiting.name || waiting.id,
      // The row names the repo, not the person who shared it. A GitHub owner
      // reads like a person ("acme/course"); a self-hosted or file:// origin's
      // "owner" is a filesystem path, and putting that in "X shared a project
      // with you" is worse than saying nothing.
      senderName: origin.owner && !origin.owner.includes('/') ? origin.owner : 'Someone',
    });
  }, [projects, pendingProject, setPendingProject]);
}

/**
 * Mount point for the watcher. The dialog itself is rendered by
 * `IncomingDeepLink`, which already owns the pending-project slot — this only
 * has to fill it, so it renders nothing.
 */
export function IncomingSharedProjects(): null {
  useIncomingSharedProjects();
  return null;
}
