import { ActionInfo, dataManager } from '@sdk';
import { extractBody } from '@sdk/fs/FrontMatterFsRef';
import { DiffContent } from '@src/components/code-editor/DiffContent';
import { MarkdownReviewDiff } from './MarkdownReviewDiff';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
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

    const get = (subpath: string, params: Record<string, string>) => {
      const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'GET');
      action.subpath = subpath;
      action.queryParameters = { workdir, file: filepath, ...params };
      return action;
    };

    Promise.all([
      dataManager.callAction<null, { content: string }>(get('show', { hash })),
      dataManager.callAction<null, { content: string }>(get('show', { hash: 'HEAD' })),
      dataManager.callAction<null, { diff: string }>(get('revision-diff', { hash })),
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
  const ready = oldContent !== null && newContent !== null && diff !== null;
  // Review compares the document BODY only — the YAML frontmatter (id, name,
  // version, …) is metadata, not prose, and diffing it produces a garbled blob.
  // The Code-diff tab still shows the full file.
  const oldBody = extractBody(oldContent ?? '');
  const newBody = extractBody(newContent ?? '');

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex flex-col" style={{ width: '95vw', maxWidth: '95vw', height: '90vh' }}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-medium">
            {filename} <span className="text-xs font-normal text-muted-foreground">— {label} vs current</span>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent" />
              <span className="text-sm">Loading comparison…</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-destructive">{error}</div>
        ) : ready ? (
          <Tabs defaultValue="review" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="w-fit shrink-0">
              <TabsTrigger value="review" data-testid="compare-tab-review">Review</TabsTrigger>
              <TabsTrigger value="code" data-testid="compare-tab-code">Code diff</TabsTrigger>
            </TabsList>
            <TabsContent value="review" className="mt-2 min-h-0 flex-1 overflow-hidden rounded-md border">
              {oldBody === newBody ? (
                <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                  No differences from the current version.
                </div>
              ) : (
                <MarkdownReviewDiff oldContent={oldBody} newContent={newBody} />
              )}
            </TabsContent>
            <TabsContent value="code" className="mt-2 min-h-0 flex-1 overflow-auto rounded-md border">
              {diff ? (
                <DiffContent diffString={diff} />
              ) : (
                <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                  No differences from the current version.
                </div>
              )}
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
