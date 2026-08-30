import { i18n } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { GitWorkdir, type GitStatus, type GitStatusFile } from '@sdk';
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { GitPushIcon } from '@src/components/status-bar/GitPushIcon';
import { GitFileDiffModal } from './GitFileDiffModal';
import type { MessageDescriptor } from '@lingui/core';

interface GitPanelProps {
  computeNodeId: string;
  workdir: string;
  /** Called after a push so an outer owner (e.g. the footer) can refresh too. */
  onPushed?: () => void;
}

function statusColor(status: string): string {
  switch (status) {
    case 'A':
      return 'text-green-500';
    case 'M':
      return 'text-amber-500';
    case 'D':
      return 'text-red-500';
    case 'R':
      return 'text-blue-400';
    case '?':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
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
const UNDO_VARIANTS: Record<string, { standard: MessageDescriptor; advanced: MessageDescriptor; tooltip: MessageDescriptor; icon: LucideIcon }> = {
  '?': {
    standard: msg`Remove`,
    advanced: msg`Discard (delete)`,
    tooltip: msg`Delete this new file — it isn't saved in git yet`,
    icon: Trash2,
  },
  D: {
    standard: msg`Bring back`,
    advanced: msg`Restore`,
    tooltip: msg`Restore this deleted file from the last commit`,
    icon: RotateCcw,
  },
  default: {
    standard: msg`Undo changes`,
    advanced: msg`Discard`,
    tooltip: msg`Restore this file to the last saved version — your edits will be lost`,
    icon: Undo2,
  },
};

function actionsFor(file: GitStatusFile, mode: GitMode): GitAction[] {
  const view: GitAction = {
    key: 'diff',
    label: t`View`,
    tooltip: t`View the changes in this file`,
    icon: Eye,
  };

  // The state-aware "undo" action — same backend op (discard-file), but its
  // label/tooltip/icon read differently per status so it always says what it
  // will actually do. Keyed by status; non-'?'/'D' (M/A/R/…) fall through to
  // the generic "discard edits" variant.
  const u = UNDO_VARIANTS[file.status] ?? UNDO_VARIANTS.default;
  const undo: GitAction = {
    key: 'discard',
    // Resolved here so `GitAction.label`/`tooltip` stay plain strings — the
    // sibling actions below build theirs with `t`, and the render sites read
    // them directly.
    label: i18n._(mode === 'standard' ? u.standard : u.advanced),
    tooltip: i18n._(u.tooltip),
    icon: u.icon,
    destructive: true,
    subpath: 'discard-file',
  };

  if (mode === 'standard') {
    return [view, undo];
  }

  // Advanced — add stage/unstage and copy-path. Staged-ness is computed by the
  // backend from the porcelain X column (GitStatusFile.staged) — the UI never
  // infers git semantics from the status char.
  const staged = file.staged;
  const stageAction: GitAction = staged
    ? {
        key: 'unstage',
        label: t`Unstage`,
        tooltip: msg`Remove this file from the next commit (git restore --staged)`,
        icon: PlusSquare,
        subpath: 'unstage-file',
      }
    : {
        key: 'stage',
        label: t`Stage`,
        tooltip: msg`Include this file in the next commit (git add)`,
        icon: PlusSquare,
        subpath: 'stage-file',
      };
  const copyPath: GitAction = {
    key: 'copyPath',
    label: t`Copy path`,
    tooltip: t`Copy this file's path to the clipboard`,
    icon: Copy,
  };
  return [view, stageAction, undo, copyPath];
}

/** Path the backend operates on — renames display as "old → new"; act on new. */
function rawPath(path: string): string {
  return path.includes(' → ') ? path.split(' → ')[1] : path;
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
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onClick}
        className={`h-5 w-5 p-0 ${className ?? 'text-muted-foreground hover:text-foreground'}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="text-xs">
      {tooltip}
    </TooltipContent>
  </Tooltip>
);

// ---------------------------------------------------------------------------
// GitPanel
// ---------------------------------------------------------------------------

export const GitPanel: React.FC<GitPanelProps> = ({ computeNodeId, workdir, onPushed }) => {
  const [data, setData] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [initing, setIniting] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitStatusFile | null>(null);
  const [mode, setMode] = useState<GitMode>('standard');
  // Row currently awaiting destructive confirmation, keyed by `${path}::${key}`.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  // Path of a row whose op is in flight, and a per-path inline error message.
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ path: string; message: string } | null>(null);
  const mountedRef = useRef(true);

  // The one door to git — every op below goes through the SDK's GitWorkdir
  // (the client mirror of the backend GitRepo; logic stays backend-only).
  const git = useMemo(() => new GitWorkdir(workdir, computeNodeId), [workdir, computeNodeId]);

  const fetchStatus = useCallback(async () => {
    if (!computeNodeId || !workdir) return;
    try {
      const result = await git.getStatus();
      if (mountedRef.current) {
        setData(result ?? null);
        setLoading(false);
      }
    } catch {
      if (mountedRef.current) setLoading(false);
    }
  }, [computeNodeId, workdir, git]);

  const { push, busy: pushing } = useGitPush(computeNodeId, workdir, () => {
    void fetchStatus();
    onPushed?.();
  });

  // Run a per-file mutation (discard / stage / unstage), then refresh the list.
  const runFileOp = useCallback(
    async (file: GitStatusFile, subpath: NonNullable<GitAction['subpath']>) => {
      setConfirmingKey(null);
      setBusyPath(file.path);
      setRowError(null);
      try {
        const ops = {
          'discard-file': () => git.discardFile(rawPath(file.path), file.status),
          'stage-file': () => git.stageFile(rawPath(file.path)),
          'unstage-file': () => git.unstageFile(rawPath(file.path)),
        } as const;
        const result = await ops[subpath]();
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
    },
    [git, fetchStatus],
  );

  const handleAction = useCallback(
    (file: GitStatusFile, action: GitAction) => {
      if (action.key === 'diff') {
        setSelectedFile(file);
        return;
      }
      if (action.key === 'copyPath') {
        void navigator.clipboard?.writeText(rawPath(file.path));
        return;
      }
      if (!action.subpath) return;
      if (action.destructive) {
        // First click arms the inline confirm; the confirm button calls runFileOp.
        setConfirmingKey(`${file.path}::${action.key}`);
        return;
      }
      void runFileOp(file, action.subpath);
    },
    [runFileOp],
  );

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, 5000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchStatus]);

  const handleGitInit = useCallback(async () => {
    if (!workdir) return;
    setIniting(true);
    setInitError(null);
    try {
      const result = await git.init();
      if (!result.ok) {
        if (mountedRef.current) setInitError(result.message || 'git init failed');
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
  }, [git, workdir, fetchStatus]);

  const renderFileRow = (f: GitStatusFile, i: number) => {
    const name = basename(f.path);
    const dir = dirname(f.path);
    const actions = actionsFor(f, mode);
    const confirming = actions.find((a) => confirmingKey === `${f.path}::${a.key}`);
    const busy = busyPath === f.path;
    const err = rowError?.path === f.path ? rowError.message : null;
    return (
      <div key={`${f.path}-${i}`} className="group rounded hover:bg-muted/50">
        <div className="flex w-full items-center gap-2 px-2 py-1">
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start"
            onClick={() => setSelectedFile(f)}
          >
            <span className={`shrink-0 text-[10px] font-bold ${statusColor(f.status)}`}>{f.status}</span>
            <div className="min-w-0 flex-1 truncate">
              <span className="text-xs font-medium">{name}</span>
              {dir && <span className="ms-1 text-[10px] text-muted-foreground">{dir}</span>}
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
                onClick={() => {
                  if (confirming.subpath) void runFileOp(f, confirming.subpath);
                }}
              />
              <IconBtn
                icon={X}
                tooltip={<Trans>Cancel</Trans>}
                className="text-muted-foreground"
                onClick={() => setConfirmingKey(null)}
              />
            </div>
          ) : (
            <>
              {/* +/- stats (hidden while the toolbar is revealed) */}
              <div className="flex shrink-0 items-center gap-0.5 text-[10px] group-hover:hidden">
                {f.insertions != null && f.insertions > 0 && <span className="text-green-500">+{f.insertions}</span>}
                {f.deletions != null && f.deletions > 0 && <span className="text-red-500">-{f.deletions}</span>}
              </div>
              {/* Action toolbar — revealed on hover */}
              <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                {actions.map((a) => (
                  <IconBtn
                    key={a.key}
                    icon={a.icon}
                    disabled={busy}
                    className={
                      a.destructive
                        ? 'text-muted-foreground hover:text-red-500'
                        : 'text-muted-foreground hover:text-foreground'
                    }
                    onClick={() => handleAction(f, a)}
                    tooltip={
                      <>
                        <span className="font-medium">{a.label}</span>
                        <span className="block text-muted-foreground">{a.tooltip}</span>
                      </>
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
        {err && <p className="px-2 pb-1 text-[10px] text-red-500">{err}</p>}
      </div>
    );
  };

  const changed = data?.files.filter((f) => f.status !== '?') ?? [];
  const newFiles = data?.files.filter((f) => f.status === '?') ?? [];

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
                    onClick={() => setMode((m) => (m === 'standard' ? 'advanced' : 'standard'))}
                    className="h-6 px-1.5 text-[10px] capitalize"
                    data-testid="git-panel-mode"
                  >
                    {mode}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  <span className="font-medium">
                    {mode === 'standard' ? <Trans>Standard mode</Trans> : <Trans>Advanced mode</Trans>}
                  </span>
                  <span className="block text-muted-foreground">
                    {mode === 'standard' ? (
                      <Trans>Simple actions — click to show all git operations</Trans>
                    ) : (
                      <Trans>All git operations — click for simplified actions</Trans>
                    )}
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
              onClick={() => {
                setLoading(true);
                void fetchStatus();
              }}
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
              <p className="text-center text-xs text-muted-foreground">
                <Trans>Not a git repository</Trans>
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                disabled={initing}
                onClick={() => {
                  void handleGitInit();
                }}
              >
                <GitBranch className="h-3.5 w-3.5" />
                {initing ? <Trans>Initializing…</Trans> : <Trans>Initialize git repo</Trans>}
              </Button>
              {initError && <p className="text-center text-[10px] text-red-500">{initError}</p>}
            </div>
          ) : !data || !data.files || data.files.length === 0 ? (
            <p className="mt-4 px-2 text-center text-xs text-muted-foreground">
              <Trans>No changes</Trans>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {changed.length > 0 && (
                <div>
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Trans>Changes ({changed.length})</Trans>
                  </p>
                  <div className="flex flex-col gap-0.5">{changed.map((f, i) => renderFileRow(f, i))}</div>
                </div>
              )}
              {newFiles.length > 0 && (
                <div>
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Trans>New Files ({newFiles.length})</Trans>
                  </p>
                  <div className="flex flex-col gap-0.5">{newFiles.map((f, i) => renderFileRow(f, i))}</div>
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
