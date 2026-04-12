import { ActionInfo, dataManager } from '@sdk';
import { DiffContent } from '@src/components/code-editor/DiffContent';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import React, { useEffect, useState } from 'react';

interface GitFileDiffModalProps {
  computeNodeId: string;
  workdir: string;
  filepath: string;
  open: boolean;
  onClose: () => void;
}

interface GitDiffData {
  diff: string | null;
  error: string | null;
}

export const GitFileDiffModal: React.FC<GitFileDiffModalProps> = ({
  computeNodeId,
  workdir,
  filepath,
  open,
  onClose,
}) => {
  const [diffData, setDiffData] = useState<GitDiffData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !computeNodeId || !workdir || !filepath) return;
    setLoading(true);
    setDiffData(null);
    const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'GET');
    action.subpath = 'diff';
    action.queryParameters = { workdir, filepath };
    dataManager.callAction<null, GitDiffData>(action)
      .then((result) => { setDiffData(result ?? null); })
      .catch(() => { setDiffData({ diff: null, error: 'Failed to fetch diff' }); })
      .finally(() => { setLoading(false); });
  }, [open, computeNodeId, workdir, filepath]);

  const filename = filepath.split('/').pop() ?? filepath;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex max-w-5xl flex-col" style={{ height: '80vh' }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-medium">
            {filename}
            <span className="ml-2 text-xs font-normal text-muted-foreground">{filepath}</span>
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
          ) : diffData?.error ? (
            <div className="flex h-full items-center justify-center p-4 text-destructive text-sm">
              {diffData.error}
            </div>
          ) : diffData?.diff === '' ? (
            <div className="flex h-full items-center justify-center p-4 text-muted-foreground text-sm">
              No unstaged changes — file may be untracked or already staged.
            </div>
          ) : diffData?.diff ? (
            <DiffContent diffString={diffData.diff} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
