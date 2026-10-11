import { resolveConflictAction } from '@src/lib/git-outcome';
import { runAction } from '@src/notifications/commands';
import { GitMerge } from 'lucide-react';
import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useGitStatus } from './GitStatusContext';

/**
 * The way back into a conflict after its toast is gone. Shown while the
 * project's tree is stuck mid-conflict — whatever sync left it there — in place
 * of Push/Pull, which would only answer "conflict" again. Runs the same
 * Resolve the toast offers; it finishes without pushing, since nothing here
 * says the user asked to publish.
 */
export const GitResolveButton: React.FC = () => {
  const status = useGitStatus();
  const { t } = useLingui();
  const conflict = status?.conflict;
  const workdir = status?.workdir;
  if (!status || !conflict || !workdir) return null;

  const files = conflict.paths.length;
  const title =
    files === 0
      ? t`Changes need merging — let the assistant finish it`
      : files === 1
        ? t`1 file needs merging — let the assistant merge it`
        : t`${files} files need merging — let the assistant merge them`;
  const resolve = () => runAction(resolveConflictAction('pull', status.branch, workdir), 'git-resolve-pill');

  return (
    <button
      type="button"
      onClick={resolve}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-700 transition-colors hover:border-amber-500/60 hover:bg-amber-500/20 dark:text-amber-300"
      title={title}
      aria-label={title}
      data-testid="git-resolve-button"
    >
      <GitMerge className="h-3.5 w-3.5 shrink-0" />
      <span>
        <Trans>Resolve</Trans>
      </span>
    </button>
  );
};
