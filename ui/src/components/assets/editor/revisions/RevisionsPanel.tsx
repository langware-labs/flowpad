import { ActionInfo, dataManager } from '@sdk';
import { GitCompare, RotateCcw } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import type { AssetRevision } from '@src/hooks/use-asset-revision-status';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { RevisionDiffModal } from './RevisionDiffModal';

interface RevisionsPanelProps {
  computeNodeId: string | null;
  workdir: string | null;
  /** Absolute path of the asset file whose history this shows. */
  file: string | null;
  revisions: AssetRevision[];
  hasRepo: boolean;
  /** Re-fetch the revision list (after a restore). */
  refresh: () => void;
  /** Reload the editor content from disk (after a restore mutates the file). */
  onRestored: () => void;
}

/**
 * "Revisions" side panel — lists an asset's git history, newest first. Each row
 * shows ``v{n} · message · relative-time`` with Restore (checkout that revision)
 * and Compare (diff vs current) actions. Mirrors the runs-tab pattern.
 */
export const RevisionsPanel: React.FC<RevisionsPanelProps> = ({
  computeNodeId,
  workdir,
  file,
  revisions,
  hasRepo,
  refresh,
  onRestored,
}) => {
  const [compare, setCompare] = useState<AssetRevision | null>(null);
  const [restoringHash, setRestoringHash] = useState<string | null>(null);

  const handleRestore = useCallback(
    async (rev: AssetRevision) => {
      if (!computeNodeId || !workdir || !file) return;
      setRestoringHash(rev.hash);
      try {
        const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'POST');
        action.subpath = 'restore-file';
        action.bodyParameters = { workdir, file, hash: rev.hash };
        await dataManager.callAction<null, { ok: boolean; message: string }>(action);
        onRestored();
        refresh();
      } catch {
        // best-effort — the panel stays usable; user can retry
      } finally {
        setRestoringHash(null);
      }
    },
    [computeNodeId, workdir, file, onRestored, refresh],
  );

  if (!hasRepo) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        No revision history yet. Saving this asset records its first revision.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-2" data-testid="revisions-panel">
      {revisions.map((rev, idx) => (
        <div
          key={rev.hash}
          className="group flex flex-col gap-1 rounded-md border-b border-border/40 px-2 py-2 last:border-b-0 hover:bg-muted/40"
          data-testid="revision-row"
        >
          <div className="flex items-center gap-2">
            {rev.version != null && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                v{rev.version}
              </span>
            )}
            {idx === 0 && (
              <span className="text-[10px] font-medium text-muted-foreground">current</span>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">{formatTimeAgo(rev.date) ?? ''}</span>
          </div>
          <span className="truncate text-xs text-foreground" title={rev.message}>{rev.message}</span>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => setCompare(rev)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="revision-compare"
            >
              <GitCompare className="h-3 w-3" /> Compare
            </button>
            {idx !== 0 && (
              <button
                type="button"
                disabled={restoringHash === rev.hash}
                onClick={() => void handleRestore(rev)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                data-testid="revision-restore"
              >
                <RotateCcw className="h-3 w-3" /> {restoringHash === rev.hash ? 'Restoring…' : 'Restore'}
              </button>
            )}
          </div>
        </div>
      ))}

      {compare && computeNodeId && workdir && file && (
        <RevisionDiffModal
          computeNodeId={computeNodeId}
          workdir={workdir}
          filepath={file}
          hash={compare.hash}
          version={compare.version}
          open={!!compare}
          onClose={() => setCompare(null)}
        />
      )}
    </div>
  );
};
