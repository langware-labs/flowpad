import { useCallback, useState } from 'react';
import { GitWorkdir } from '@sdk';
import { notifyGitFailure, notifyGitOutcome } from '@src/lib/git-outcome';
import { prepareProjectAutoLaunch } from '@src/agents/agent-auto-launch';
import { flushAgentAutoLaunchWarning } from '@src/agents/agent-auto-launch-warning';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewMode } from '@src/contexts/view-mode-context';

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
  const { navigation } = useDockNavigation();

  const pull = useCallback(async () => {
    if (!computeNodeId || !workdir || busy) return;
    setBusy(true);
    try {
      const result = await new GitWorkdir(workdir, computeNodeId).pull();
      notifyGitOutcome('pull', result, workdir);
      if (result.refreshError) {
        notifyGitFailure('pull', new Error(result.refreshError), workdir);
      } else if (result.ok && result.projectId) {
        const processId = await prepareProjectAutoLaunch(result.projectId, true);
        flushAgentAutoLaunchWarning();
        if (processId) await navigation.openShellProcess(processId, { viewMode: ViewMode.Vibe });
      }
    } catch (e) {
      notifyGitFailure('pull', e, workdir);
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter, navigation]);

  return { pull, busy };
}
