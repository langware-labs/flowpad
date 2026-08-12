import React, { useEffect, useState } from 'react';
import { ActionInfo, GitWorkdir, type FSRef, dataManager } from '@sdk';
import { extractBody } from '@sdk/fs/FrontMatterFsRef';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { AssetDiffTabs } from '@src/components/assets/editor/revisions/AssetDiffTabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { invalidateGitStatus } from '@src/lib/git-status-cache';
import { notify } from '@src/notifications';

interface ImprovementResultsModalProps {
  /** SKILL.md the improvement edited (working tree, possibly dirty). */
  skillFile: FSRef;
  skillName: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful commit so the host can refresh dirty/version state. */
  onCommitted?: () => void;
  /** Optional value stamp shown in the header (e.g. "3 findings · ~$26/mo banked (projected)"). */
  valueNote?: string;
}

/**
 * The "improvement results" diff for a skillit CORRECT run: HEAD (committed)
 * vs the working tree (the in-place edits), in a Review (word) + Code tab, with
 * a whole-improvement Reject / Save & create version footer. Mirrors
 * `RevisionDiffModal` but compares against the working tree and adds the actions.
 */
export const ImprovementResultsModal: React.FC<ImprovementResultsModalProps> = ({
  skillFile,
  skillName,
  open,
  onClose,
  onCommitted,
  valueNote,
}) => {
  const computeNodeId = skillFile.typeId.id;
  const workdir = skillFile.parent.path;
  const file = skillFile.path.slice(skillFile.path.lastIndexOf('/') + 1);

  const [oldContent, setOldContent] = useState<string | null>(null);
  const [newContent, setNewContent] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'reject' | 'commit' | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setOldContent(null);
    setNewContent(null);
    setDiff(null);
    setError(null);

    const git = new GitWorkdir(workdir, computeNodeId);
    Promise.all([
      git.show(file, 'HEAD'),
      skillFile.read(),
      // HEAD-vs-working-tree (the uncommitted improvement); `revisionDiff`
      // only compares committed revisions, so `fileDiff` is correct here.
      git.fileDiff(file, 'M'),
    ])
      .then(([headRes, working, diffRes]) => {
        setOldContent(headRes?.content ?? '');
        setNewContent(working ?? '');
        setDiff(diffRes?.diff ?? '');
      })
      .catch(() => setError('Failed to load the improvement diff'))
      .finally(() => setLoading(false));
    // skillFile path is stable for a given skill; re-fetch on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, computeNodeId, workdir, file]);

  const reject = async () => {
    setBusy('reject');
    try {
      const r = await new GitWorkdir(workdir, computeNodeId).discardFile(file, 'M');
      if (r && r.ok === false) {
        notify.error({ title: 'Could not discard', message: r.message || 'Discard failed' });
        return;
      }
      invalidateGitStatus(computeNodeId, workdir);
      notify.info({ title: `Discarded ${skillName} improvement`, message: 'Restored to the last committed version.' });
      onCommitted?.();
      onClose();
    } catch (e) {
      notify.error({ title: 'Discard failed', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const saveVersion = async () => {
    setBusy('commit');
    try {
      const action = new ActionInfo('commit-asset', 'compute_node', computeNodeId, 'POST');
      action.bodyParameters = { workdir, file };
      const r = await dataManager.callAction<null, { committed: boolean; version?: number }>(action);
      if (r?.committed) {
        notify.success({ title: `Committed ${skillName} v${r.version}` });
        invalidateGitStatus(computeNodeId, workdir);
        onCommitted?.();
        onClose();
      } else {
        notify.info({ title: 'Nothing to commit', message: 'The skill matches HEAD.' });
      }
    } catch (e) {
      notify.error({ title: 'Commit failed', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const ready = oldContent !== null && newContent !== null && diff !== null;
  const oldBody = extractBody(oldContent ?? '');
  const newBody = extractBody(newContent ?? '');
  const unchanged = ready && oldBody === newBody && !diff;

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
            {skillName}/SKILL.md{' '}
            <span className="text-xs font-normal text-muted-foreground">— improvement vs last version</span>
            {valueNote && (
              <span
                className="ms-2 text-[11px] font-normal text-emerald-600 dark:text-emerald-400"
                data-testid="improvement-value-note"
              >
                {valueNote}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <AssetDiffTabs
          oldBody={oldBody}
          newBody={newBody}
          diff={diff ?? ''}
          loading={loading}
          error={error}
          emptyLabel="No changes to the skill body."
        />

        <div className="flex shrink-0 items-center justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={!!busy}>
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reject()}
            disabled={!!busy || unchanged}
            className="text-destructive hover:text-destructive"
            data-testid="improvement-reject"
          >
            {busy === 'reject' ? (
              <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="me-1 h-3.5 w-3.5" />
            )}
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() => void saveVersion()}
            disabled={!!busy || unchanged}
            data-testid="improvement-save-version"
          >
            {busy === 'commit' ? (
              <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="me-1 h-3.5 w-3.5" />
            )}
            Save &amp; create version
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
