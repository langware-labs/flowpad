import { useCallback, useState } from 'react';
import { ActionInfo, dataManager } from '@sdk';
import { notify } from '@src/notifications/notify';
import { getViewMode } from '@src/components/view-mode';
import { pushToastCopy, type PushKind } from '@src/lib/publish-state';

interface PushResult {
  ok: boolean;
  conflict: boolean;
  nothing: boolean;
  /** Typed outcome from GitRepo._classify_push_error (back-compat: may be absent). */
  kind?: PushKind;
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
      // Typed outcome → plain-language, mode-aware copy. Fall back to flags when
      // an older backend doesn't send `kind`.
      const kind: PushKind = res?.kind ?? (res?.nothing ? 'nothing' : res?.conflict ? 'conflict' : res?.ok ? 'pushed' : 'generic');
      const copy = pushToastCopy(kind, getViewMode(), { branch: res?.branch, message: res?.message });
      if (copy.level === 'success') {
        notify.success({ title: copy.title, message: copy.message, durationMs: 4000 });
      } else {
        notify.error({
          title: copy.title,
          message: copy.message,
          durationMs: null,
          // The conflict-resolver agent is an Advanced-only affordance.
          actions: copy.resolvable
            ? [{ label: 'Resolve', command: 'git.resolve-conflict', args: { branch: res?.branch ?? '' } }]
            : undefined,
        });
      }
    } catch (e) {
      const copy = pushToastCopy('generic', getViewMode(), { message: e instanceof Error ? e.message : String(e) });
      notify.error({ title: copy.title, message: copy.message, durationMs: null });
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter]);

  return { push, busy };
}
