import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useGitFolderStatus } from '@src/hooks/use-git-folder-status';
import { GitPushIcon } from '@src/components/status-bar/GitPushIcon';
import { GitStatusModal } from '@src/components/status-bar/GitStatusModal';
import { PushContextFolderDialog } from './PushContextFolderDialog';

interface ContextFolderGitBadgeProps {
  /** Absolute path of the git context folder (the repo workdir). */
  workdir: string;
  /** Compute node id whose git-ops back the status/push. */
  computeNodeId: string;
  /** Folder basename — labels the push dialog. */
  folderName: string;
  /** The Folder entity typeid — the push dialog's git-link chip. */
  folderTypeId?: string | null;
  /** Scoped project — anchors the push dialog's conversation options. */
  projectId?: string | null;
}

/**
 * ContextFolderGitBadge — the always-visible git pills on a context-folder
 * TREE row (the footer status-bar pair, relocated per folder):
 *   - amber changes pill (branch icon + pending count) → opens the Git
 *     changes modal (the same GitPanel the footer pill opens);
 *   - sky Push pill → opens {@link PushContextFolderDialog} (push + optional
 *     notify), i.e. the full push flow rather than the footer's one-click push.
 * Renders nothing while the folder is clean. Clicks never bubble into the
 * row (which would navigate).
 */
export function ContextFolderGitBadge({
  workdir,
  computeNodeId,
  folderName,
  folderTypeId,
  projectId,
}: ContextFolderGitBadgeProps) {
  const { t } = useLingui();
  const { status, hasUnpushed, push, pushing, refresh } = useGitFolderStatus(workdir, computeNodeId);
  const [changesOpen, setChangesOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);

  const count = status?.files?.length ?? 0;
  if (count === 0 && !hasUnpushed) return null;

  return (
    // Clicks must not bubble into the tree row (which would navigate) — the
    // span is a bubble fence, not an interactive element itself.
    <span
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      data-testid={`context-folder-git-badge-${folderName}`}
    >
      {count > 0 && (
        <button
          type="button"
          onClick={() => setChangesOpen(true)}
          title={t`${count} pending change(s) — click to view diff`}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
          data-testid="context-folder-changes-pill"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="tabular-nums">{count}</span>
        </button>
      )}
      {hasUnpushed && (
        <button
          type="button"
          onClick={() => setPushOpen(true)}
          disabled={pushing}
          title={t`Push ${folderName}`}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[10px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-300"
          data-testid="context-folder-push-pill"
        >
          <GitPushIcon busy={pushing} />
          <span>{t`Push`}</span>
        </button>
      )}
      <GitStatusModal
        open={changesOpen}
        onClose={() => {
          setChangesOpen(false);
          void refresh();
        }}
        computeNodeId={computeNodeId}
        workdir={workdir}
        onPushed={() => void refresh()}
      />
      <PushContextFolderDialog
        open={pushOpen}
        onOpenChange={(o) => {
          setPushOpen(o);
          if (!o) void refresh();
        }}
        folderName={folderName}
        branch={status?.branch ?? null}
        projectId={projectId}
        folderTypeId={folderTypeId}
        push={push}
        pushing={pushing}
      />
    </span>
  );
}
