import { GitBranch } from 'lucide-react';
import React, { useState } from 'react';
import { useGitStatus } from './GitStatusContext';
import { GitStatusModal } from './GitStatusModal';

/**
 * Footer pill for the current project's git repo. Always shown when the
 * workdir is a repo: neutral (branch icon only) when the tree is clean, amber
 * with the pending-change count when there is something to commit. Hidden only
 * when there is no repo. Clicking it opens the existing git-diff screen
 * (``GitPanel``) as a modal. Reads the shared GitStatusContext.
 */
export const GitStatusPill: React.FC = () => {
  const status = useGitStatus();
  const [open, setOpen] = useState(false);

  if (!status || !status.hasRepo || !status.computeNodeId || !status.workdir) return null;
  const { computeNodeId, workdir, count, branch, refresh } = status;
  const hasChanges = !!count && count > 0;
  const branchLabel = branch ? ` on ${branch}` : '';
  const title = hasChanges
    ? `${count} pending change${count === 1 ? '' : 's'}${branchLabel} — click to view diff`
    : `Git repository${branchLabel} — clean, click to view`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          hasChanges
            ? 'inline-flex h-5 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-700 transition-colors hover:border-amber-500/60 hover:bg-amber-500/20 dark:text-amber-300'
            : 'inline-flex h-5 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted'
        }
        title={title}
        aria-label={hasChanges ? `${count} pending git changes` : 'Git repository, no pending changes'}
        data-testid="git-status-pill"
        data-git-state={hasChanges ? 'dirty' : 'clean'}
      >
        <GitBranch className="h-3 w-3 shrink-0" />
        {hasChanges && <span className="tabular-nums">{count}</span>}
      </button>
      <GitStatusModal
        open={open}
        onClose={() => { setOpen(false); refresh?.(); }}
        computeNodeId={computeNodeId}
        workdir={workdir}
        onPushed={refresh}
      />
    </>
  );
};
