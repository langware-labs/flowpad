import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionInfo, dataManager, GitWorkdir, type GitAssetDiff, type GitStatusFile } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { DiffContent } from './DiffContent';
import { AssetDiffTabs } from '@src/components/assets/editor/revisions/AssetDiffTabs';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { invalidateGitStatus } from '@src/lib/git-status-cache';
import { decodeAssetComparePointer, type AssetComparePointerPayload } from '@src/navigation/DockPointer';
import { notify } from '@src/notifications';
import { FileText, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react';

const ALL_CHANGES = '__all__';

interface FileCompare {
  oldContent: string;
  newContent: string;
  diff: string;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  const after = text.indexOf('\n', end + 4);
  return after >= 0 ? text.slice(after + 1) : '';
}

function displayStatus(status: string): string {
  if (status === '?') return 'A';
  return status || 'M';
}

function statusClass(status: string): string {
  if (status === '?' || status === 'A') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'D') return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

async function fetchFileCompare(git: GitWorkdir, file: GitStatusFile): Promise<FileCompare> {
  const path = file.path.includes(' → ') ? file.path.split(' → ', 2)[1] : file.path;
  const [oldRes, newRes, diffRes] = await Promise.all([
    file.status === '?' ? Promise.resolve({ content: '' }) : git.show(path, 'HEAD').catch(() => ({ content: '' })),
    git.workingFile(path).catch(() => ({ content: '' })),
    git.fileDiff(path, file.status).catch(() => ({ diff: '' })),
  ]);
  return { oldContent: oldRes.content, newContent: newRes.content, diff: diffRes.diff };
}

export function AssetCompareView({ pointer }: { pointer?: string | null }) {
  const payload = useMemo(() => decodeAssetComparePointer(pointer), [pointer]);
  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        <Trans>Invalid asset comparison.</Trans>
      </div>
    );
  }
  return <AssetCompare payload={payload} />;
}

function AssetCompare({ payload }: { payload: AssetComparePointerPayload }) {
  const git = useMemo(() => new GitWorkdir(payload.workdir, payload.computeNodeId), [payload.computeNodeId, payload.workdir]);
  const [assetDiff, setAssetDiff] = useState<GitAssetDiff | null>(null);
  const [selectedKey, setSelectedKey] = useState(ALL_CHANGES);
  const [fileCompare, setFileCompare] = useState<FileCompare | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await git.assetDiff(payload.file);
      setAssetDiff(next);
      if (!next.files.some((f) => f.path === selectedKey)) {
        setSelectedKey(next.files.length === 1 ? next.files[0].path : ALL_CHANGES);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [git, payload.file, selectedKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedFile = useMemo(
    () => assetDiff?.files.find((f) => f.path === selectedKey) ?? null,
    [assetDiff?.files, selectedKey],
  );

  useEffect(() => {
    if (!selectedFile) {
      setFileCompare(null);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    setFileCompare(null);
    fetchFileCompare(git, selectedFile)
      .then((next) => {
        if (!cancelled) setFileCompare(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [git, selectedFile]);

  const saveVersion = useCallback(async () => {
    setSaving(true);
    try {
      const action = new ActionInfo('commit-asset', 'compute_node', payload.computeNodeId, 'POST');
      action.bodyParameters = { workdir: payload.workdir, file: payload.file };
      const result = await dataManager.callAction<null, { committed: boolean; version?: number }>(action);
      invalidateGitStatus(payload.computeNodeId, payload.workdir);
      if (result?.committed) {
        notify.success({ title: `Saved ${payload.assetLabel} v${result.version ?? ''}`.trim() });
      } else {
        notify.info({ title: 'Nothing to save', message: 'The asset matches HEAD.' });
      }
      await refresh();
    } catch (err) {
      notify.error({ title: 'Save failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }, [payload, refresh]);

  const hasChanges = !!assetDiff?.diff || !!assetDiff?.files.length;
  const oldBody = stripFrontmatter(fileCompare?.oldContent ?? '');
  const newBody = stripFrontmatter(fileCompare?.newContent ?? '');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            <Trans>Asset compare</Trans>: {payload.assetLabel}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={payload.assetPath}>
            {payload.assetPath}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || saving}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          <Trans>Refresh</Trans>
        </Button>
        <Button size="sm" onClick={() => void saveVersion()} disabled={saving || loading || !hasChanges}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
          <Trans>Save version</Trans>
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r bg-muted/20 p-2">
          <button
            type="button"
            className={cn(
              'mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs',
              selectedKey === ALL_CHANGES ? 'bg-background shadow-sm' : 'hover:bg-background/70',
            )}
            onClick={() => setSelectedKey(ALL_CHANGES)}
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate"><Trans>All changes</Trans></span>
            {assetDiff?.files.length ? (
              <span className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {assetDiff.files.length}
              </span>
            ) : null}
          </button>
          {assetDiff?.files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs',
                selectedKey === file.path ? 'bg-background shadow-sm' : 'hover:bg-background/70',
              )}
              onClick={() => setSelectedKey(file.path)}
              title={file.path}
            >
              <span className={cn('rounded border px-1 py-0.5 text-[10px] font-medium', statusClass(file.status))}>
                {displayStatus(file.status)}
              </span>
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
            </button>
          ))}
        </aside>

        <main className="min-h-0 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <Trans>Loading asset diff…</Trans>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">{error}</div>
          ) : selectedFile ? (
            <div className="flex h-full min-h-0 flex-col p-3">
              <AssetDiffTabs
                oldBody={oldBody}
                newBody={newBody}
                diff={fileCompare?.diff ?? ''}
                loading={fileLoading}
                error={null}
                emptyLabel="No differences in this file."
              />
            </div>
          ) : assetDiff?.diff ? (
            <div className="h-full overflow-auto">
              <DiffContent diffString={assetDiff.diff} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              <Trans>No changes to show</Trans>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
