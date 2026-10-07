import { useCallback, useState } from 'react';
import { GitWorkdir } from '@sdk';
import { notify } from '@src/notifications/notify';
import { getViewMode } from '@src/components/view-mode';
import { pullToastCopy } from '@src/lib/publish-state';

export interface UseGitPullResult {
  /** Bring the upstream's commits in (pull --rebase --autostash). */
  pull: () => Promise<void>;
  /** True while a pull is in flight. */
  busy: boolean;
}

/**
 * One-click "non-tech" pull — the inbound twin of ``useGitPush``: same toast
 * shape, same Resolve action on a conflict, same ``onAfter`` refresh hook.
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
      const res = await new GitWorkdir(workdir, computeNodeId).pull();
      const copy = pullToastCopy(res?.kind ?? 'generic', getViewMode(), { branch: res?.branch, message: res?.message });
      if (copy.level === 'success') {
        notify.success({ title: copy.title, message: copy.message, durationMs: 4000 });
      } else {
        // The toast is the only answer to the click — and on a conflict it carries
        // the Resolve action — so it pops in every view, not only Dev.
        notify.error({
          title: copy.title,
          message: copy.message,
          durationMs: null,
          forceToast: true,
          actions: copy.resolvable
            ? [
                {
                  label: 'Resolve',
                  command: 'git.resolve-conflict',
                  args: { branch: res?.branch ?? '', origin: 'pull' },
                },
              ]
            : undefined,
        });
      }
    } catch (e) {
      const copy = pullToastCopy('generic', getViewMode(), { message: e instanceof Error ? e.message : String(e) });
      notify.error({ title: copy.title, message: copy.message, durationMs: null, forceToast: true });
    } finally {
      setBusy(false);
      onAfter?.();
    }
  }, [computeNodeId, workdir, busy, onAfter]);

  return { pull, busy };
}
