import { useCallback, useMemo, useState } from 'react';
import { TypeId, launchWizard, type Project } from '@sdk';
import { notify } from '@src/notifications';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { useGitPush } from '@src/hooks/use-git-push';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';
import {
  gitShareGateState,
  type GitShareGateState,
} from '@src/components/share-to-conversation/git-share-gate-state';
import type { ContextFolderTarget } from '@src/hooks/use-context-folder-for-rel';

export interface GitShareGate {
  /** Which face the gate renders — `checking` until the backend answers. */
  state: GitShareGateState;
  /** The backend's human-readable reason (null when available). */
  reason: string | null;
  /** True while a remediation (setup / commit+push) is running. */
  busy: boolean;
  /** Run the git-setup wizard, then re-check. */
  runSetup: () => Promise<void>;
  /** Commit AND push, then re-check. */
  runCommit: () => Promise<void>;
}

/**
 * The pre-share gate for a context folder: preflight → remediate → re-check.
 *
 * Re-checking is EVENT-driven, never polled: each remediation calls the
 * preflight's `refetch` once it settles — one re-check, on an explicit
 * completion. No interval, no backoff, no retry budget.
 */
export function useGitShareGate(
  folder: ContextFolderTarget | null,
  project: Project | null | undefined,
  enabled: boolean,
): GitShareGate {
  const [setupBusy, setSetupBusy] = useState(false);
  const { addPaths, remove } = useProjectContextFolders(project);

  const ref = useMemo(() => (folder?.typeid ? new TypeId(folder.typeid) : undefined), [folder?.typeid]);
  const preflight = useGitSharePreflight(ref, enabled);

  // `push` owns its own busy state and re-entrancy guard — don't shadow it.
  const { push, busy: pushBusy } = useGitPush(
    folder?.computeNodeId ?? '@local',
    folder?.workdir ?? null,
    preflight.refetch,
  );

  // ONE action: stage-all → commit → pull --rebase → push. The receiver clones
  // the origin, so an unpushed commit is unreachable — a commit without the
  // push would leave the share just as broken.
  const runCommit = useCallback(() => push(), [push]);

  const runSetup = useCallback(async () => {
    if (!folder || !project) return;
    setSetupBusy(true);
    try {
      const result = await launchWizard<{ path?: string }>('git-context-folder', {
        title: 'Set up Git for sharing',
        targetTypeId: project.typeId.toString(),
        payload: {
          projectId: project.id,
          scope: 'private',
          mode: 'adopt',
          path: folder.workdir,
          name: folder.name,
        },
        prompt:
          `The user wants to share the context folder "${folder.name}" (${folder.workdir}), but it ` +
          `isn't backed by a git repository with an "origin" remote yet, so it can't be shared. ` +
          `Adopt THAT EXACT FOLDER in place — do not clone it, copy it, or create a repository ` +
          `anywhere else. Initialize git in ${folder.workdir} if needed, commit its current ` +
          `contents, create the "origin" remote, and push. Report when the folder has a working ` +
          `origin remote and a pushed commit.`,
      });
      if (result.status === 'error') {
        notify.error({ title: 'Could not set up Git', message: result.errorStr ?? undefined });
        return;
      }
      if (result.status !== 'done') return;
      // Re-register so the backend re-runs `detect_origin`: a Folder's identity
      // IS its origin key, so a now-git directory must be re-minted, not mutated
      // in place — otherwise it keeps its stale LocalOrigin forever and every
      // later preflight re-probes a folder the graph still calls local.
      await remove(folder.workdir);
      await addPaths([folder.workdir], 'private');
    } catch (e) {
      notify.error({ title: 'Could not set up Git', message: String(e) });
    } finally {
      setSetupBusy(false);
      preflight.refetch();
    }
  }, [folder, project, addPaths, remove, preflight]);

  const busy = pushBusy || setupBusy;
  return {
    // IDLE and AVAILABLE both carry `code: null`, so `answered` — not the code —
    // is what separates "not asked yet" from "asked, fine".
    state: preflight.loading || busy || !preflight.answered ? 'checking' : gitShareGateState(preflight.code),
    reason: preflight.reason,
    busy,
    runSetup,
    runCommit,
  };
}
