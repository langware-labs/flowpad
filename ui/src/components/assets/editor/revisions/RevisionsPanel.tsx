import { GitWorkdir, type GitRevision } from '@sdk';
import { GitBranch, GitCompare, RotateCcw } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Button } from '@src/components/ui/button';
import { useProject } from '@src/hooks/useProject';
import { RevisionDiffModal } from './RevisionDiffModal';

interface RevisionsPanelProps {
  computeNodeId: string | null;
  workdir: string | null;
  /** Absolute path of the asset file whose history this shows. */
  file: string | null;
  revisions: GitRevision[];
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
  const [compare, setCompare] = useState<GitRevision | null>(null);
  const [restoringHash, setRestoringHash] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const { project } = useProject();

  // Init a git repo at the *project* working tree so the whole project (this
  // file included) gets local revisions. On success, refresh so the panel flips
  // to the history/empty-history state. Mirrors GitPanel.handleGitInit.
  const handleSetupGit = useCallback(async () => {
    if (!project) return;
    setSettingUp(true);
    setSetupError(null);
    try {
      const gw = await project.getGitWorkdir();
      if (!gw) {
        setSetupError('No working directory for this project.');
        return;
      }
      const result = await gw.init();
      if (result.ok) {
        refresh();
      } else {
        setSetupError(result.message || 'git init failed');
      }
    } catch (e) {
      setSetupError(String(e));
    } finally {
      setSettingUp(false);
    }
  }, [project, refresh]);

  const handleRestore = useCallback(
    async (rev: GitRevision) => {
      if (!computeNodeId || !workdir || !file) return;
      setRestoringHash(rev.hash);
      try {
        await new GitWorkdir(workdir, computeNodeId).restoreFile(file, rev.hash);
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
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center"
        data-testid="revisions-no-repo"
      >
        <p className="text-xs text-muted-foreground">
          Revisions require git. Set it up to record local revisions for this project.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={settingUp || !project}
          onClick={() => { void handleSetupGit(); }}
          data-testid="revisions-setup-git"
        >
          <GitBranch className="h-3.5 w-3.5" />
          {settingUp ? 'Setting up…' : 'Setup git'}
        </Button>
        {setupError && (
          <p className="text-[10px] text-red-500">{setupError}</p>
        )}
      </div>
    );
  }

  if (revisions.length === 0) {
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
