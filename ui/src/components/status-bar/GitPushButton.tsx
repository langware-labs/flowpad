import { useGitPush } from '@src/hooks/use-git-push';
import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitPushIcon } from './GitPushIcon';
import { useGitStatus } from './GitStatusContext';

/**
 * One-click "non-tech" push for the current project, shown next to the pending
 * pill. Hidden unless there is something to push: uncommitted changes, or local
 * commits not yet pushed (an asset save the backend auto-committed). Reads the shared
 * GitStatusContext and refreshes it after a push so the pill updates too.
 */
export const GitPushButton: React.FC = () => {
  const status = useGitStatus();
  const computeNodeId = status?.computeNodeId ?? null;
  const workdir = status?.workdir ?? null;
  const { push, busy } = useGitPush(computeNodeId, workdir, status?.refresh);
  const { t } = useLingui();

  const pending = (status?.count ?? 0) > 0 || (status?.ahead ?? 0) > 0;
  if (!status || !status.hasRepo || !pending || !computeNodeId || !workdir) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => void push()}
      disabled={busy}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[10px] font-medium text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/20 disabled:opacity-60 dark:text-sky-300"
      title={t`git push`}
      aria-label={t`git push`}
      data-testid="git-push-button"
    >
      <GitPushIcon busy={busy} />
      <span>
        <Trans>Push</Trans>
      </span>
    </button>
  );
};
