import { useCallback, useState } from 'react';
import { GitWorkdir } from '@sdk';
import { notifyGitFailure, notifyGitOutcome } from '@src/lib/git-outcome';

export interface UseGitPushResult {
  /** Run the greedy push (commit-all → pull --rebase → push). */
  push: () => Promise<void>;
  /** True while a push is in flight. */
  busy: boolean;
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
): UseGitPushResult {
  const [busy, setBusy] = useState(false);

  const push = useCallback(async () => {
    if (!computeNodeId || !workdir || busy) return;
    setBusy(true);
    try {
      notifyGitOutcome('push', await new GitWorkdir(workdir, computeNodeId).push(), workdir);
    } catch (e) {
      notifyGitFailure('push', e, workdir);
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter]);

  return { push, busy };
}
