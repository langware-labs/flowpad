import { useGitPush } from '@src/hooks/use-git-push';
import React from 'react';
import { GitPushIcon } from './GitPushIcon';
import { useGitStatus } from './GitStatusContext';

/**
 * One-click "non-tech" push for the current project, shown next to the pending
 * pill. Hidden unless there are pending changes. Reads the shared
 * GitStatusContext and refreshes it after a push so the pill updates too.
 */
export const GitPushButton: React.FC = () => {
  const status = useGitStatus();
  const computeNodeId = status?.computeNodeId ?? null;
  const workdir = status?.workdir ?? null;
  const { push, busy } = useGitPush(computeNodeId, workdir, status?.refresh);

  if (!status || !status.hasRepo || !status.count || status.count <= 0 || !computeNodeId || !workdir) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => void push()}
      disabled={busy}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[10px] font-medium text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/20 disabled:opacity-60 dark:text-sky-300"
      title="git push"
      aria-label="git push"
      data-testid="git-push-button"
    >
      <GitPushIcon busy={busy} />
      <span>Push</span>
    </button>
  );
};
