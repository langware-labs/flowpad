import { useGitPull } from '@src/hooks/use-git-pull';
import { CloudDownload, Loader2 } from 'lucide-react';
import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useGitStatus } from './GitStatusContext';

/**
 * One-click "pull from cloud" for the current project — the inbound twin of
 * ``GitPushButton``. Hidden while the tree is stuck in a conflict
 * (``GitResolveButton`` stands in), and unless the upstream has commits this checkout lacks;
 * ``behind`` comes from the background fetch the shared GitStatusContext runs
 * after each status check, and the context refreshes after the pull.
 */
export const GitPullButton: React.FC = () => {
  const status = useGitStatus();
  const computeNodeId = status?.computeNodeId ?? null;
  const workdir = status?.workdir ?? null;
  const { pull, busy } = useGitPull(computeNodeId, workdir, status?.refresh);
  const { t } = useLingui();

  const behind = status?.behind ?? 0;
  if (!status || !status.hasRepo || status.conflict || behind <= 0 || !computeNodeId || !workdir) {
    return null;
  }

  const title =
    behind === 1 ? t`1 new change in the cloud — pull it` : t`${behind} new changes in the cloud — pull them`;
  return (
    <button
      type="button"
      onClick={() => void pull()}
      disabled={busy}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 text-[10px] font-medium text-emerald-700 transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/20 disabled:opacity-60 dark:text-emerald-300"
      title={title}
      aria-label={title}
      data-testid="git-pull-button"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <CloudDownload className="h-3.5 w-3.5 shrink-0" />
      )}
      <span>
        <Trans>Pull</Trans>
      </span>
    </button>
  );
};
