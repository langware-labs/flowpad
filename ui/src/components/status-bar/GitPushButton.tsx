import { useGitPush } from '@src/hooks/use-git-push';
import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitPushIcon } from './GitPushIcon';
import { useGitStatus } from './GitStatusContext';

/**
 * One-click "non-tech" push for the current project, shown next to the pending
 * pill. Hidden while the tree is stuck in a conflict (``GitResolveButton``
 * stands in), and unless there is something to push: uncommitted changes, or local
 * commits not yet pushed (an asset save the backend auto-committed). Reads the shared
 * GitStatusContext and refreshes it after a push so the pill updates too.
 */
export const GitPushButton: React.FC = () => {
  const status = useGitStatus();
  const computeNodeId = status?.computeNodeId ?? null;
  const workdir = status?.workdir ?? null;
  const { push, busy } = useGitPush(computeNodeId, workdir, status?.refresh);
  const { t } = useLingui();

  const ahead = status?.ahead ?? 0;
  const pending = (status?.count ?? 0) > 0 || ahead > 0;
  if (!status || !status.hasRepo || status.conflict || !pending || !computeNodeId || !workdir) {
    return null;
  }

  // The count is the commits waiting to go up; uncommitted-only shows no number
  // (the pending pill beside it already counts those files).
  const title =
    ahead === 0 ? t`git push` : ahead === 1 ? t`git push — 1 commit to push` : t`git push — ${ahead} commits to push`;

  return (
    <button
      type="button"
      onClick={() => void push()}
      disabled={busy}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[10px] font-medium text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/20 disabled:opacity-60 dark:text-sky-300"
      title={title}
      aria-label={title}
      data-testid="git-push-button"
    >
      <GitPushIcon busy={busy} />
      <span>
        <Trans>Push</Trans>
      </span>
      {ahead > 0 && (
        <span className="tabular-nums" data-testid="git-push-ahead-count">
          {ahead}
        </span>
      )}
    </button>
  );
};
