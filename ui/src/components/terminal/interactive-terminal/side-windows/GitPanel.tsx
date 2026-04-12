import { ActionInfo, dataManager, Shell } from '@sdk';
import { GitBranch, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DiffEditor, Monaco } from '@monaco-editor/react';
import gitDiffParser, { Change, File as DiffFile, Hunk } from 'gitdiff-parser';
import { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { createHighlighter, Highlighter } from 'shiki';
import { shikiToMonaco } from '@shikijs/monaco';

interface GitFile {
  status: string;
  path: string;
  insertions: number | null;
  deletions: number | null;
}

interface GitStatusData {
  error: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

interface GitPanelProps {
  computeNodeId: string;
  workdir: string;
  sidecarShellId?: string | null;
}

function statusColor(status: string): string {
  switch (status) {
    case 'A': return 'text-green-500';
    case 'M': return 'text-amber-500';
    case 'D': return 'text-red-500';
    case 'R': return 'text-blue-400';
    case '?': return 'text-muted-foreground';
    default:  return 'text-muted-foreground';
  }
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '';
}

// ---------------------------------------------------------------------------
// Shiki singleton
// ---------------------------------------------------------------------------

let shikiHighlighter: Highlighter | null = null;
let shikiLoadingPromise: Promise<void> | null = null;

function ensureShiki(): Promise<void> {
  if (!shikiLoadingPromise) {
    shikiLoadingPromise = createHighlighter({ themes: ['dark-plus', 'light-plus'], langs: ['text'] })
      .then((h) => { shikiHighlighter = h; })
      .catch(() => { shikiLoadingPromise = null; });
  }
  return shikiLoadingPromise;
}

// ---------------------------------------------------------------------------
// FileDiffModal — simple portal-based modal (avoids Radix Dialog z-index issues)
// ---------------------------------------------------------------------------

interface FileDiffModalProps {
  file: GitFile;
  computeNodeId: string;
  workdir: string;
  onClose: () => void;
}

const FileDiffModal: React.FC<FileDiffModalProps> = ({ file, computeNodeId, workdir, onClose }) => {
  const { resolvedTheme } = useTheme();
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const editorInstancesRef = useRef<Map<string, editor.IStandaloneDiffEditor>>(new Map());

  // Fetch diff on mount
  useEffect(() => {
    const rawPath = file.path.includes(' → ') ? file.path.split(' → ')[1]! : file.path;

    const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'GET');
    action.subpath = 'diff';
    action.queryParameters = { workdir, file: rawPath, status: file.status };

    dataManager.callAction<null, { diff: string }>(action)
      .then((result) => { setDiff(result?.diff ?? ''); })
      .catch((e: unknown) => { setError(String(e)); })
      .finally(() => setLoading(false));
  }, [file, computeNodeId, workdir]);

  // Dispose editors on unmount
  useEffect(() => {
    const instances = editorInstancesRef.current;
    return () => {
      instances.forEach((e) => { try { e.dispose(); } catch { /* ignore */ } });
      instances.clear();
    };
  }, []);

  const parsedDiff: DiffFile[] = React.useMemo(() => {
    if (!diff) return [];
    try { return gitDiffParser.parse(diff); } catch { return []; }
  }, [diff]);

  const handleEditorMount = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor, monaco: Monaco, key: string) => {
      editorInstancesRef.current.set(key, diffEditor);
      void ensureShiki().then(() => {
        if (!shikiHighlighter) return;
        monaco.languages.register({ id: 'text' });
        shikiToMonaco(shikiHighlighter, monaco);
        monaco.editor.setTheme(resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus');
      });
    },
    [resolvedTheme],
  );

  const renderHunk = useCallback(
    (hunk: Hunk, hunkIndex: number, fileIndex: number) => {
      const key = `f${fileIndex}-h${hunkIndex}`;
      const originalLines = hunk.changes
        .filter((c: Change) => c.type === 'delete' || c.type === 'normal')
        .map((c: Change) => `${c.type === 'delete' ? '-' : ' '}${c.content}`)
        .join('\n');
      const modifiedLines = hunk.changes
        .filter((c: Change) => c.type === 'insert' || c.type === 'normal')
        .map((c: Change) => `${c.type === 'insert' ? '+' : ' '}${c.content}`)
        .join('\n');
      const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      const original = `${header}\n${originalLines}`;
      const modified = `${header}\n${modifiedLines}`;
      const lineHeight = 20;
      const padding = 16;
      const height = Math.max(original.split('\n').length, modified.split('\n').length) * lineHeight + padding * 2;

      return (
        <div key={key} className="border-t first:border-t-0">
          <div className="bg-muted/50 px-3 py-1 text-[10px] text-muted-foreground font-mono">
            {header}
          </div>
          <DiffEditor
            height={`${height}px`}
            language="text"
            original={original}
            modified={modified}
            onMount={(e, m) => handleEditorMount(e, m, key)}
            theme={resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus'}
            options={{
              renderSideBySide: true,
              readOnly: true,
              fontSize: 12,
              lineHeight,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: padding, bottom: padding },
              lineNumbers: 'on',
              glyphMargin: false,
              scrollbar: { alwaysConsumeMouseWheel: false },
            }}
          />
        </div>
      );
    },
    [handleEditorMount, resolvedTheme],
  );

  const title = file.path.includes(' → ') ? file.path : basename(file.path);

  const modal = (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)' }} />

      {/* Panel */}
      <div
        style={{
          position: 'absolute',
          top: '5%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '90vw',
          maxWidth: '1100px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '8px',
          overflow: 'hidden',
          boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
        }}
        className="border bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium font-mono">{title}</span>
            <span className={`text-[10px] font-bold ${statusColor(file.status)}`}>
              {file.status}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-muted/70 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : parsedDiff.length > 0 ? (
            <div className="space-y-4 p-4">
              {parsedDiff.map((fileDiff, fi) => (
                <div key={fi} className="overflow-hidden rounded-lg border">
                  <div className="border-b bg-muted px-4 py-2 text-xs font-medium font-mono">
                    {fileDiff.newPath || fileDiff.oldPath}
                  </div>
                  <div>
                    {fileDiff.hunks.map((hunk, hi) => renderHunk(hunk, hi, fi))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              No diff to display
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};

// ---------------------------------------------------------------------------
// GitPanel
// ---------------------------------------------------------------------------

export const GitPanel: React.FC<GitPanelProps> = ({ computeNodeId, workdir, sidecarShellId }) => {
  const [data, setData] = useState<GitStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [initing, setIniting] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFile | null>(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    if (!computeNodeId || !workdir) return;
    const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'GET');
    action.subpath = 'status';
    action.queryParameters = { workdir };
    try {
      const result = await dataManager.callAction<null, GitStatusData>(action);
      if (mountedRef.current) {
        setData(result ?? null);
        setLoading(false);
      }
    } catch {
      if (mountedRef.current) setLoading(false);
    }
  }, [computeNodeId, workdir]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    void fetchStatus();
    const interval = setInterval(() => { void fetchStatus(); }, 5000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchStatus]);

  const handleGitInit = useCallback(async () => {
    if (!sidecarShellId || !workdir) return;
    setIniting(true);
    setInitError(null);
    try {
      const shell = await Shell.getById(sidecarShellId);
      if (!shell) throw new Error('Sidecar shell not found');
      const result = await shell.run(`git -C '${workdir}' init`);
      if (result.exitCode !== 0) {
        if (mountedRef.current) setInitError(result.stderr.trim() || 'git init failed');
      } else {
        if (mountedRef.current) {
          setLoading(true);
          void fetchStatus();
        }
      }
    } catch (e) {
      if (mountedRef.current) setInitError(String(e));
    } finally {
      if (mountedRef.current) setIniting(false);
    }
  }, [sidecarShellId, workdir, fetchStatus]);

  const renderFileRow = (f: GitFile, i: number) => {
    const name = basename(f.path);
    const dir = dirname(f.path);
    return (
      <button
        key={`${f.path}-${i}`}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted/50 cursor-pointer"
        onClick={() => setSelectedFile(f)}
      >
        <span className={`shrink-0 text-[10px] font-bold ${statusColor(f.status)}`}>
          {f.status}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium">{name}</span>
          {dir && (
            <span className="ml-1 text-[10px] text-muted-foreground">{dir}</span>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-0.5 text-[10px]">
          {f.insertions != null && f.insertions > 0 && (
            <span className="text-green-500">+{f.insertions}</span>
          )}
          {f.deletions != null && f.deletions > 0 && (
            <span className="text-red-500">-{f.deletions}</span>
          )}
        </div>
      </button>
    );
  };

  const changed = data?.files.filter(f => f.status !== '?') ?? [];
  const newFiles = data?.files.filter(f => f.status === '?') ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {data?.error ? 'Not a git repo' : (data?.branch ?? 'git')}
          </span>
          {data && !data.error && data.ahead > 0 && (
            <span className="shrink-0 rounded-full bg-green-500/20 px-1.5 py-0.5 text-[9px] font-bold text-green-500">
              ↑{data.ahead}
            </span>
          )}
          {data && !data.error && data.behind > 0 && (
            <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-500">
              ↓{data.behind}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setLoading(true); void fetchStatus(); }}
          className="h-6 w-6 p-0"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-1">
        {loading && !data ? (
          <div className="flex flex-col gap-1.5 p-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : data?.error ? (
          <div className="flex flex-col items-center gap-3 px-3 py-6">
            <p className="text-center text-xs text-muted-foreground">Not a git repository</p>
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={!sidecarShellId || initing}
                    onClick={() => { void handleGitInit(); }}
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    {initing ? 'Initializing…' : 'Initialize git repo'}
                  </Button>
                </TooltipTrigger>
                {!sidecarShellId && (
                  <TooltipContent side="bottom" className="text-xs">
                    Open the sidecar shell first to enable git operations
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            {initError && (
              <p className="text-center text-[10px] text-red-500">{initError}</p>
            )}
          </div>
        ) : !data || !data.files || data.files.length === 0 ? (
          <p className="mt-4 px-2 text-center text-xs text-muted-foreground">No changes</p>
        ) : (
          <div className="flex flex-col gap-2">
            {changed.length > 0 && (
              <div>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Changes ({changed.length})
                </p>
                <div className="flex flex-col gap-0.5">
                  {changed.map((f, i) => renderFileRow(f, i))}
                </div>
              </div>
            )}
            {newFiles.length > 0 && (
              <div>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  New Files ({newFiles.length})
                </p>
                <div className="flex flex-col gap-0.5">
                  {newFiles.map((f, i) => renderFileRow(f, i))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Diff modal — rendered via portal so it's always on top */}
      {selectedFile && (
        <FileDiffModal
          file={selectedFile}
          computeNodeId={computeNodeId}
          workdir={workdir}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
};
