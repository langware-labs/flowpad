import { GitBranch } from 'lucide-react';
import React, { useState } from 'react';
import { useGitStatus } from './GitStatusContext';
import { GitStatusModal } from './GitStatusModal';

/**
 * Footer pill showing the count of pending git changes for the current project.
 * Hidden when there's no repo or nothing pending. Clicking it opens the existing
 * git-diff screen (``GitPanel``) as a modal. Reads the shared GitStatusContext.
 */
export const GitStatusPill: React.FC = () => {
  const status = useGitStatus();
  const [open, setOpen] = useState(false);

  if (!status || !status.hasRepo || !status.computeNodeId || !status.workdir) return null;
  const { computeNodeId, workdir, count, refresh } = status;
  const hasChanges = !!count && count > 0;
  // Hide the pill when the tree is clean — but keep an already-open modal mounted
  // (e.g. you pushed from inside it and the count just dropped to 0) so it doesn't
  // close out from under you.
  if (!hasChanges && !open) return null;

  return (
    <>
      {hasChanges && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-700 transition-colors hover:border-amber-500/60 hover:bg-amber-500/20 dark:text-amber-300"
          title={`${count} pending change${count === 1 ? '' : 's'} — click to view diff`}
          aria-label={`${count} pending git changes`}
          data-testid="git-status-pill"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="tabular-nums">{count}</span>
        </button>
      )}
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
