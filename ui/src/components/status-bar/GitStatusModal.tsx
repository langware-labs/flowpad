import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { GitPanel } from '@src/components/terminal/interactive-terminal/side-windows';
import React from 'react';

interface GitStatusModalProps {
  open: boolean;
  onClose: () => void;
  computeNodeId: string;
  workdir: string;
  /** Refresh the outer (footer) git status after a push from inside the modal. */
  onPushed?: () => void;
}

/**
 * Opens the existing ``GitPanel`` (status list + per-file diff) as a modal.
 * Reuses the same git-diff screen that lives in the interactive terminal's
 * side window — no separate UI.
 */
export const GitStatusModal: React.FC<GitStatusModalProps> = ({
  open,
  onClose,
  computeNodeId,
  workdir,
  onPushed,
}) => {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="flex flex-col p-0"
        style={{ width: '90vw', maxWidth: '1000px', height: '85vh' }}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-sm font-medium">Git changes</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <GitPanel computeNodeId={computeNodeId} workdir={workdir} onPushed={onPushed} />
        </div>
      </DialogContent>
    </Dialog>
  );
};
