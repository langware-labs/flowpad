import { GitWorkdir, type GitFileDiff } from '@sdk';
import { DiffContent } from '@src/components/code-editor/DiffContent';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Trans, useLingui } from '@lingui/react/macro';
import React, { useEffect, useState } from 'react';

interface GitFileDiffModalProps {
  computeNodeId: string;
  workdir: string;
  filepath: string;
  status?: string;
  open: boolean;
  onClose: () => void;
}

export const GitFileDiffModal: React.FC<GitFileDiffModalProps> = ({
  computeNodeId,
  workdir,
  filepath,
  status = 'M',
  open,
  onClose,
}) => {
  const { t } = useLingui();
  const [diffData, setDiffData] = useState<GitFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !computeNodeId || !workdir || !filepath) return;
    setLoading(true);
    setDiffData(null);
    setError(null);
    new GitWorkdir(workdir, computeNodeId)
      .fileDiff(filepath, status)
      .then((result) => {
        setDiffData(result ?? null);
      })
      .catch(() => {
        setError(t`Failed to fetch diff`);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, computeNodeId, workdir, filepath, status, t]);

  const filename = filepath.split('/').pop() ?? filepath;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="flex flex-col" style={{ width: '95vw', maxWidth: '95vw', height: '90vh' }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-medium">
            {filename}
            <span className="ms-2 text-xs font-normal text-muted-foreground">{filepath}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <div className="h-6 w-6 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent" />
                <span className="text-sm">
                  <Trans>Loading diff…</Trans>
                </span>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">{error}</div>
          ) : diffData?.diff === '' ? (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              <Trans>No changes to show.</Trans>
            </div>
          ) : diffData?.diff ? (
            <DiffContent diffString={diffData.diff} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
