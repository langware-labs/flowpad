import { useCallback, useState } from 'react';
import { GitWorkdir } from '@sdk';
import { notifyGitFailure, notifyGitOutcome } from '@src/lib/git-outcome';

export interface UseGitPullResult {
  /** Bring the upstream's commits in (pull --rebase --autostash). */
  pull: () => Promise<void>;
  /** True while a pull is in flight. */
  busy: boolean;
}

/**
 * One-click "non-tech" pull — the inbound twin of ``useGitPush``: the same
 * ``notifyGitOutcome`` toast, the same Resolve on a conflict, the same
 * ``onAfter`` refresh hook.
 */
export function useGitPull(
  computeNodeId: string | null,
  workdir: string | null,
  onAfter?: () => void,
): UseGitPullResult {
  const [busy, setBusy] = useState(false);

  const pull = useCallback(async () => {
    if (!computeNodeId || !workdir || busy) return;
    setBusy(true);
    try {
      notifyGitOutcome('pull', await new GitWorkdir(workdir, computeNodeId).pull(), workdir);
    } catch (e) {
      notifyGitFailure('pull', e, workdir);
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter]);

  return { pull, busy };
}
