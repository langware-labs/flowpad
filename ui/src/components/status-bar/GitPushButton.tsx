import { useGitPush } from '@src/hooks/use-git-push';
import type { GitWorkdir } from '@sdk';
import { Check } from 'lucide-react';
import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitPushIcon } from './GitPushIcon';
import { useGitStatus } from './GitStatusContext';

/**
 * Push for the current project, shown next to the pending pill. With local
 * commits waiting it is "Push commits <n>": pushes those commits and commits nothing
 * (uncommitted files stay put). With none waiting but files pending it becomes
 * "Push all changes": commit everything, then push. Hidden while the tree is stuck in a
 * conflict (``GitResolveButton`` stands in) and when there is nothing to push.
 * Reads the shared GitStatusContext and refreshes it after a push so the pill
 * updates too.
 */
/** Plain push: the commits already made, nothing new committed. */
const pushCommitsOnly = (git: GitWorkdir) => git.pushCommits();
/** Push all changes: commit every pending file, then push. */
const pushAll = (git: GitWorkdir) => git.push();

export const GitPushButton: React.FC = () => {
  const status = useGitStatus();
  const computeNodeId = status?.computeNodeId ?? null;
  const workdir = status?.workdir ?? null;
  const ahead = status?.ahead ?? 0;
  const all = ahead === 0 && (status?.count ?? 0) > 0;
  const { push, busy, pushed } = useGitPush(
    computeNodeId,
    workdir,
    status?.refresh,
    all ? pushAll : pushCommitsOnly,
    true,
  );
  const { t } = useLingui();

  if (pushed) {
    return (
      <span
        className="inline-flex h-5 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
        data-testid="git-push-done"
      >
        <Check className="h-3 w-3" />
        <Trans>Pushed</Trans>
      </span>
    );
  }
  if (!status || !status.hasRepo || status.conflict || (ahead === 0 && !all) || !computeNodeId || !workdir) {
    return null;
  }

  const title = all
    ? t`Commit all pending changes and push`
    : ahead === 1
      ? t`git push — 1 commit to push`
      : t`git push — ${ahead} commits to push`;

  return (
    <button
      type="button"
      onClick={() => void push()}
      disabled={busy}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[10px] font-medium text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/20 disabled:opacity-60 dark:text-sky-300"
      title={title}
      aria-label={title}
      data-testid={all ? 'git-push-all-button' : 'git-push-button'}
    >
      <GitPushIcon busy={busy} />
      {all ? (
        <span>
          <Trans>Push all changes</Trans>
        </span>
      ) : (
        <>
          <span>
            <Trans>Push commits</Trans>
          </span>
          <span className="tabular-nums" data-testid="git-push-ahead-count">
            {ahead}
          </span>
        </>
      )}
    </button>
  );
};
