import { ActionInfo, dataManager, Shell } from '@sdk';
import { GitBranch, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
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

export const GitPanel: React.FC<GitPanelProps> = ({ computeNodeId, workdir, sidecarShellId }) => {
  const [data, setData] = useState<GitStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [initing, setIniting] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
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
        ) : (() => {
          const changed = data.files.filter(f => f.status !== '?');
          const newFiles = data.files.filter(f => f.status === '?');
          const renderFile = (f: GitFile, i: number) => {
            const name = basename(f.path);
            const dir = dirname(f.path);
            return (
              <button key={`${f.path}-${i}`} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted/50" onClick={() => setSelectedFile(f.path)}>
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
          return (
            <div className="flex flex-col gap-2">
              {changed.length > 0 && (
                <div>
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Changes ({changed.length})
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {changed.map((f, i) => renderFile(f, i))}
                  </div>
                </div>
              )}
              {newFiles.length > 0 && (
                <div>
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    New Files ({newFiles.length})
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {newFiles.map((f, i) => renderFile(f, i))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
      {selectedFile && (
        <GitFileDiffModal
          computeNodeId={computeNodeId}
          workdir={workdir}
          filepath={selectedFile}
          open={!!selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
};
