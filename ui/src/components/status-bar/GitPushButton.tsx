import { useGitPush } from '@src/hooks/use-git-push';
import type { GitWorkdir } from '@sdk';
import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitPushIcon } from './GitPushIcon';
import { useGitStatus } from './GitStatusContext';

/**
 * Plain push for the current project, shown next to the pending pill: pushes the
 * commits already made and commits nothing (uncommitted files stay put). Hidden
 * while the tree is stuck in a conflict (``GitResolveButton`` stands in), and
 * unless there are local commits not yet pushed. Reads the shared
 * GitStatusContext and refreshes it after a push so the pill updates too.
 */
/** Plain push: the commits already made, nothing new committed. */
const pushCommitsOnly = (git: GitWorkdir) => git.pushCommits();

export const GitPushButton: React.FC = () => {
  const status = useGitStatus();
  const computeNodeId = status?.computeNodeId ?? null;
  const workdir = status?.workdir ?? null;
  const { push, busy } = useGitPush(computeNodeId, workdir, status?.refresh, pushCommitsOnly);
  const { t } = useLingui();

  const ahead = status?.ahead ?? 0;
  if (!status || !status.hasRepo || status.conflict || ahead === 0 || !computeNodeId || !workdir) {
    return null;
  }

  const title = ahead === 1 ? t`git push — 1 commit to push` : t`git push — ${ahead} commits to push`;

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
      <span className="tabular-nums" data-testid="git-push-ahead-count">
        {ahead}
      </span>
    </button>
  );
};
