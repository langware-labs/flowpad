import { ActionInfo, dataManager, Shell } from '@sdk';
import { useGitPush } from '@src/hooks/use-git-push';
import {
  Check,
  Copy,
  Eye,
  GitBranch,
  type LucideIcon,
  PlusSquare,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { GitPushIcon } from '@src/components/status-bar/GitPushIcon';
import { GitFileDiffModal } from './GitFileDiffModal';

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
  /** Called after a push so an outer owner (e.g. the footer) can refresh too. */
  onPushed?: () => void;
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
// Per-file action model — maps a file's status + the panel mode to an ordered
// list of actions. Standard = plain, non-technical labels; Advanced = full git
// ops. Every action carries a tooltip explaining what it does.
// ---------------------------------------------------------------------------

type GitMode = 'standard' | 'advanced';

interface GitAction {
  key: 'diff' | 'discard' | 'stage' | 'unstage' | 'copyPath';
  label: string;
  tooltip: string;
  icon: LucideIcon;
  destructive?: boolean;
  // POST sub-path for backend mutations; absent for client-only actions.
  subpath?: 'discard-file' | 'stage-file' | 'unstage-file';
}

// Per-status copy/icon for the state-aware discard action. `default` covers
// every tracked-edit status (M/A/R/…) not given its own entry.
const UNDO_VARIANTS: Record<string, { standard: string; advanced: string; tooltip: string; icon: LucideIcon }> = {
  '?': { standard: 'Remove', advanced: 'Discard (delete)', tooltip: "Delete this new file — it isn't saved in git yet", icon: Trash2 },
  D: { standard: 'Bring back', advanced: 'Restore', tooltip: 'Restore this deleted file from the last commit', icon: RotateCcw },
  default: { standard: 'Undo changes', advanced: 'Discard', tooltip: 'Restore this file to the last saved version — your edits will be lost', icon: Undo2 },
};

function actionsFor(file: GitFile, mode: GitMode): GitAction[] {
  const view: GitAction = {
    key: 'diff',
    label: 'View',
    tooltip: 'View the changes in this file',
    icon: Eye,
  };

  // The state-aware "undo" action — same backend op (discard-file), but its
  // label/tooltip/icon read differently per status so it always says what it
  // will actually do. Keyed by status; non-'?'/'D' (M/A/R/…) fall through to
  // the generic "discard edits" variant.
  const u = UNDO_VARIANTS[file.status] ?? UNDO_VARIANTS.default;
  const undo: GitAction = {
    key: 'discard',
    label: mode === 'standard' ? u.standard : u.advanced,
    tooltip: u.tooltip,
    icon: u.icon,
    destructive: true,
    subpath: 'discard-file',
  };

  if (mode === 'standard') {
    return [view, undo];
  }

  // Advanced — add stage/unstage and copy-path. 'A'/'R' only exist in the
  // index, so they're definitively staged → offer Unstage. The single status
  // char can't tell a staged 'M'/'D' from an unstaged one, so default to Stage
  // (git add is idempotent, so staging an already-staged file is harmless).
  const staged = file.status === 'A' || file.status === 'R';
  const stageAction: GitAction = staged
    ? {
        key: 'unstage',
        label: 'Unstage',
        tooltip: 'Remove this file from the next commit (git restore --staged)',
        icon: PlusSquare,
        subpath: 'unstage-file',
      }
    : {
        key: 'stage',
        label: 'Stage',
        tooltip: 'Include this file in the next commit (git add)',
        icon: PlusSquare,
        subpath: 'stage-file',
      };
  const copyPath: GitAction = {
    key: 'copyPath',
    label: 'Copy path',
    tooltip: "Copy this file's path to the clipboard",
    icon: Copy,
  };
  return [view, stageAction, undo, copyPath];
}

/** Path the backend operates on — renames display as "old → new"; act on new. */
function rawPath(path: string): string {
  return path.includes(' → ') ? path.split(' → ')[1]! : path;
}

/** A 5×5 ghost icon-button with a bottom tooltip — the one button shape every
 *  row action (toolbar, confirm, cancel) uses. `tooltip` may be a node so the
 *  toolbar can render its label + description. */
const IconBtn: React.FC<{
  icon: LucideIcon;
  tooltip: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}> = ({ icon: Icon, tooltip, onClick, disabled, className }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={onClick} className={`h-5 w-5 p-0 ${className ?? 'text-muted-foreground hover:text-foreground'}`}>
        <Icon className="h-3.5 w-3.5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
  </Tooltip>
);

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
              <Trans>No diff to display</Trans>
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

export const GitPanel: React.FC<GitPanelProps> = ({ computeNodeId, workdir, sidecarShellId, onPushed }) => {
  const [data, setData] = useState<GitStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [initing, setIniting] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFile | null>(null);
  const [mode, setMode] = useState<GitMode>('standard');
  // Row currently awaiting destructive confirmation, keyed by `${path}::${key}`.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  // Path of a row whose op is in flight, and a per-path inline error message.
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ path: string; message: string } | null>(null);
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

  const { push, busy: pushing } = useGitPush(computeNodeId, workdir, () => { void fetchStatus(); onPushed?.(); });

  // Run a per-file mutation (discard / stage / unstage), then refresh the list.
  const runFileOp = useCallback(async (file: GitFile, subpath: NonNullable<GitAction['subpath']>) => {
    setConfirmingKey(null);
    setBusyPath(file.path);
    setRowError(null);
    try {
      const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'POST');
      action.subpath = subpath;
      action.queryParameters = { workdir, file: rawPath(file.path), status: file.status };
      const result = await dataManager.callAction<null, { ok: boolean; message: string }>(action);
      if (!mountedRef.current) return;
      if (result && result.ok === false) {
        setRowError({ path: file.path, message: result.message || 'Operation failed' });
      } else {
        void fetchStatus();
      }
    } catch (e) {
      if (mountedRef.current) setRowError({ path: file.path, message: String(e) });
    } finally {
      if (mountedRef.current) setBusyPath(null);
    }
  }, [computeNodeId, workdir, fetchStatus]);

  const handleAction = useCallback((file: GitFile, action: GitAction) => {
    if (action.key === 'diff') { setSelectedFile(file); return; }
    if (action.key === 'copyPath') { void navigator.clipboard?.writeText(rawPath(file.path)); return; }
    if (!action.subpath) return;
    if (action.destructive) {
      // First click arms the inline confirm; the confirm button calls runFileOp.
      setConfirmingKey(`${file.path}::${action.key}`);
      return;
    }
    void runFileOp(file, action.subpath);
  }, [runFileOp]);

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
    const actions = actionsFor(f, mode);
    const confirming = actions.find(a => confirmingKey === `${f.path}::${a.key}`);
    const busy = busyPath === f.path;
    const err = rowError?.path === f.path ? rowError.message : null;
    return (
      <div key={`${f.path}-${i}`} className="group rounded hover:bg-muted/50">
        <div className="flex w-full items-center gap-2 px-2 py-1">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
            onClick={() => setSelectedFile(f)}
          >
            <span className={`shrink-0 text-[10px] font-bold ${statusColor(f.status)}`}>
              {f.status}
            </span>
            <div className="min-w-0 flex-1 truncate">
              <span className="text-xs font-medium">{name}</span>
              {dir && (
                <span className="ml-1 text-[10px] text-muted-foreground">{dir}</span>
              )}
            </div>
          </button>

          {confirming ? (
            // Inline confirm for a destructive action — replaces the toolbar.
            <div className="flex shrink-0 items-center gap-1">
              <span className="text-[10px] text-muted-foreground">{confirming.label}?</span>
              <IconBtn
                icon={Check}
                tooltip={<Trans>Confirm</Trans>}
                disabled={busy}
                className="text-red-500 hover:text-red-600"
                onClick={() => { if (confirming.subpath) void runFileOp(f, confirming.subpath); }}
              />
              <IconBtn icon={X} tooltip={<Trans>Cancel</Trans>} className="text-muted-foreground" onClick={() => setConfirmingKey(null)} />
            </div>
          ) : (
            <>
              {/* +/- stats (hidden while the toolbar is revealed) */}
              <div className="shrink-0 flex items-center gap-0.5 text-[10px] group-hover:hidden">
                {f.insertions != null && f.insertions > 0 && (
                  <span className="text-green-500">+{f.insertions}</span>
                )}
                {f.deletions != null && f.deletions > 0 && (
                  <span className="text-red-500">-{f.deletions}</span>
                )}
              </div>
              {/* Action toolbar — revealed on hover */}
              <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                {actions.map((a) => (
                  <IconBtn
                    key={a.key}
                    icon={a.icon}
                    disabled={busy}
                    className={a.destructive ? 'text-muted-foreground hover:text-red-500' : 'text-muted-foreground hover:text-foreground'}
                    onClick={() => handleAction(f, a)}
                    tooltip={<>
                      <span className="font-medium">{a.label}</span>
                      <span className="block text-muted-foreground">{a.tooltip}</span>
                    </>}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        {err && (
          <p className="px-2 pb-1 text-[10px] text-red-500">{err}</p>
        )}
      </div>
    );
  };

  const changed = data?.files.filter(f => f.status !== '?') ?? [];
  const newFiles = data?.files.filter(f => f.status === '?') ?? [];

  return (
    <TooltipProvider delayDuration={400}>
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {data?.error ? <Trans>Not a git repo</Trans> : (data?.branch ?? 'git')}
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
        <div className="flex items-center gap-1">
          {!data?.error && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode(m => (m === 'standard' ? 'advanced' : 'standard'))}
                  className="h-6 px-1.5 text-[10px] capitalize"
                  data-testid="git-panel-mode"
                >
                  {mode}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <span className="font-medium">{mode === 'standard' ? <Trans>Standard mode</Trans> : <Trans>Advanced mode</Trans>}</span>
                <span className="block text-muted-foreground">
                  {mode === 'standard'
                    ? <Trans>Simple actions — click to show all git operations</Trans>
                    : <Trans>All git operations — click for simplified actions</Trans>}
                </span>
              </TooltipContent>
            </Tooltip>
          )}
          {!data?.error && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void push()}
              disabled={pushing}
              className="h-6 gap-1 px-1.5 text-[10px]"
              title="git push"
              data-testid="git-panel-push"
            >
              <GitPushIcon busy={pushing} />
              <Trans>Push</Trans>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setLoading(true); void fetchStatus(); }}
            className="h-6 w-6 p-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
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
            <p className="text-center text-xs text-muted-foreground"><Trans>Not a git repository</Trans></p>
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
                    {initing ? <Trans>Initializing…</Trans> : <Trans>Initialize git repo</Trans>}
                  </Button>
                </TooltipTrigger>
                {!sidecarShellId && (
                  <TooltipContent side="bottom" className="text-xs">
                    <Trans>Open the sidecar shell first to enable git operations</Trans>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            {initError && (
              <p className="text-center text-[10px] text-red-500">{initError}</p>
            )}
          </div>
        ) : !data || !data.files || data.files.length === 0 ? (
          <p className="mt-4 px-2 text-center text-xs text-muted-foreground"><Trans>No changes</Trans></p>
        ) : (
          <div className="flex flex-col gap-2">
            {changed.length > 0 && (
              <div>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Changes ({changed.length})</Trans>
                </p>
                <div className="flex flex-col gap-0.5">
                  {changed.map((f, i) => renderFileRow(f, i))}
                </div>
              </div>
            )}
            {newFiles.length > 0 && (
              <div>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>New Files ({newFiles.length})</Trans>
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
        <GitFileDiffModal
          computeNodeId={computeNodeId}
          workdir={workdir}
          filepath={selectedFile.path}
          status={selectedFile.status}
          open={!!selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
    </TooltipProvider>
  );
};
