import { GitWorkdir } from '@sdk';
import { extractBody } from '@sdk/fs/FrontMatterFsRef';
import { AssetDiffTabs } from './AssetDiffTabs';
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

/**
 * Compare a past revision of an asset file against the current version, in two
 * tabs: **Review** (default — Word-style inline diff of the rendered markdown via
 * ``MarkdownReviewDiff``) and **Code diff** (the unified-diff Monaco view via
 * ``DiffContent``). The Review tab needs both full versions (``git-ops/show`` at
 * the hash and at HEAD); the Code tab uses the existing ``revision-diff``.
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
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [newContent, setNewContent] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !computeNodeId || !workdir || !filepath || !hash) return;
    setLoading(true);
    setOldContent(null);
    setNewContent(null);
    setDiff(null);
    setError(null);

    const git = new GitWorkdir(workdir, computeNodeId);
    Promise.all([
      git.show(filepath, hash),
      git.show(filepath, 'HEAD'),
      git.revisionDiff(filepath, hash),
    ])
      .then(([oldRes, newRes, diffRes]) => {
        setOldContent(oldRes?.content ?? '');
        setNewContent(newRes?.content ?? '');
        setDiff(diffRes?.diff ?? '');
      })
      .catch(() => setError('Failed to load comparison'))
      .finally(() => setLoading(false));
  }, [open, computeNodeId, workdir, filepath, hash]);

  const filename = filepath.split('/').pop() ?? filepath;
  const label = version != null ? `v${version}` : hash.slice(0, 8);
  // Review compares the document BODY only — the YAML frontmatter (id, name,
  // version, …) is metadata, not prose, and diffing it produces a garbled blob.
  // The Code-diff tab still shows the full file.
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex flex-col" style={{ width: '95vw', maxWidth: '95vw', height: '90vh' }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-medium">
            {filename} <span className="text-xs font-normal text-muted-foreground">— {label} vs current</span>
          </DialogTitle>
        </DialogHeader>
        <AssetDiffTabs
          oldBody={extractBody(oldContent ?? '')}
          newBody={extractBody(newContent ?? '')}
          diff={diff ?? ''}
          loading={loading}
          error={error}
        />
      </DialogContent>
    </Dialog>
  );
};
