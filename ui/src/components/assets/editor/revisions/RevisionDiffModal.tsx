import { ActionInfo, dataManager } from '@sdk';
import { DiffContent } from '@src/components/code-editor/DiffContent';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import React, { useEffect, useState } from 'react';

interface RevisionDiffModalProps {
  computeNodeId: string;
  workdir: string;
  filepath: string;
  /** Past revision hash to compare against the current working tree. */
  hash: string;
  /** Version label of the compared revision, for the header. */
  version: number | null;
  open: boolean;
  onClose: () => void;
}

interface GitFileDiff {
  diff: string;
}

/**
 * Compare a past revision of an asset file against the current working tree.
 * Reuses the shared ``DiffContent`` viewer; fetches via the ``git-ops
 * revision-diff`` sub-path (``git diff <hash> HEAD -- <file>``).
 */
export const RevisionDiffModal: React.FC<RevisionDiffModalProps> = ({
  computeNodeId,
  workdir,
  filepath,
  hash,
  version,
  open,
  onClose,
}) => {
  const [diffData, setDiffData] = useState<GitFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !computeNodeId || !workdir || !filepath || !hash) return;
    setLoading(true);
    setDiffData(null);
    setError(null);
    const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'GET');
    action.subpath = 'revision-diff';
    action.queryParameters = { workdir, file: filepath, hash };
    dataManager
      .callAction<null, GitFileDiff>(action)
      .then((result) => { setDiffData(result ?? null); })
      .catch(() => { setError('Failed to fetch diff'); })
      .finally(() => { setLoading(false); });
  }, [open, computeNodeId, workdir, filepath, hash]);

  const filename = filepath.split('/').pop() ?? filepath;
  const label = version != null ? `v${version}` : hash.slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex flex-col" style={{ width: '95vw', maxWidth: '95vw', height: '90vh' }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-medium">
            {filename} <span className="text-xs font-normal text-muted-foreground">— {label} vs current</span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <div className="h-6 w-6 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent" />
                <span className="text-sm">Loading diff…</span>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-4 text-destructive text-sm">{error}</div>
          ) : diffData?.diff === '' ? (
            <div className="flex h-full items-center justify-center p-4 text-muted-foreground text-sm">
              No differences from the current version.
            </div>
          ) : diffData?.diff ? (
            <DiffContent diffString={diffData.diff} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
