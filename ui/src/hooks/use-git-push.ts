import { useCallback, useEffect, useState } from 'react';
import { GitWorkdir, type GitPushResult } from '@sdk';
import { notifyGitFailure, notifyGitOutcome } from '@src/lib/git-outcome';

export interface UseGitPushResult {
  /** Run the greedy push (commit-all → pull --rebase → push). */
  push: () => Promise<void>;
  /** True while a push is in flight. */
  busy: boolean;
  /** True for 3s after a successful push (only with `quietSuccess`, which skips the toast). */
  pushed: boolean;
}

/**
 * Shared one-click "non-tech" push: commit-all → pull --rebase → push. The
 * outcome is toasted by ``notifyGitOutcome`` — the same toast, and the same
 * Resolve on a conflict, as every other sync.
 *
 * Used by the footer push button, the Git panel header, the asset Publish pill
 * and the share gate. ``onAfter`` is invoked after every attempt (success or
 * fail) so the caller can refresh whatever status view it owns.
 */
export function useGitPush(
  computeNodeId: string | null,
  workdir: string | null,
  onAfter?: () => void,
  /** The push to run — the greedy commit-all push unless the caller picks another (e.g. `pushCommits`). */
  op: (git: GitWorkdir) => Promise<GitPushResult> = (git) => git.push(),
  /** Skip the success toast; the caller shows `pushed` inline instead. */
  quietSuccess = false,
): UseGitPushResult {
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState(false);

  useEffect(() => {
    if (!pushed) return;
    const id = setTimeout(() => setPushed(false), 3000);
    return () => clearTimeout(id);
  }, [pushed]);

  const push = useCallback(async () => {
    if (!computeNodeId || !workdir || busy) return;
    setBusy(true);
    try {
      const ok = notifyGitOutcome('push', await op(new GitWorkdir(workdir, computeNodeId)), workdir, quietSuccess);
      if (ok && quietSuccess) setPushed(true);
    } catch (e) {
      notifyGitFailure('push', e, workdir);
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter, op, quietSuccess]);

  return { push, busy, pushed };
}
