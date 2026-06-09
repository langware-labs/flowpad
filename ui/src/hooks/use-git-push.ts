import { useCallback, useState } from 'react';
import { ActionInfo, dataManager } from '@sdk';
import { notify } from '@src/notifications/notify';

interface PushResult {
  ok: boolean;
  conflict: boolean;
  nothing: boolean;
  branch: string | null;
  message: string;
}

export interface UseGitPushResult {
  /** Run the greedy push (commit-all → pull --rebase → push). */
  push: () => Promise<void>;
  /** True while a push is in flight. */
  busy: boolean;
}

/**
 * Shared one-click "non-tech" push: commit-all → pull --rebase → push. Success →
 * a brief "Great" toast; conflict → an error toast with a "Resolve" button that
 * launches the agentic conflict resolver (registered command `git.resolve-conflict`).
 *
 * Used by both the footer push button and the git modal header so the behaviour
 * is defined once. ``onAfter`` is invoked after every attempt (success or fail)
 * so the caller can refresh whatever status view it owns.
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
      const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'POST');
      action.subpath = 'push';
      action.bodyParameters = { workdir };
      const res = await dataManager.callAction<null, PushResult>(action);
      if (res?.ok) {
        notify.success({
          title: res.nothing ? 'Nothing to push' : 'Great',
          message: res.message,
          durationMs: 4000,
        });
      } else {
        notify.error({
          title: res?.conflict ? 'Push hit a conflict' : 'Push failed',
          message: res?.message ?? 'Could not push.',
          durationMs: null,
          actions: res?.conflict
            ? [{ label: 'Resolve', command: 'git.resolve-conflict', args: { branch: res?.branch ?? '' } }]
            : undefined,
        });
      }
    } catch (e) {
      notify.error({
        title: 'Push failed',
        message: e instanceof Error ? e.message : String(e),
        durationMs: null,
      });
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter]);

  return { push, busy };
}
