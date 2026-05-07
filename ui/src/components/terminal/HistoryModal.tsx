import { AgenticProcess } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Checkbox } from '@src/components/ui/checkbox';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import {
  PromptIndexPanel,
  usePromptsForProcess,
} from '@src/components/terminal/interactive-terminal/side-windows';
import { cn } from '@src/lib/utils';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useProject } from '@src/hooks/useProject';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ArrowDown, ArrowUp, MessageSquare, Search } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortId(id: string): string {
  return id.slice(0, 6);
}

function pickLabelFallback(entry: WorkerHistoryEntry): string {
  const name = (entry.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== entry.worker_id) {
    return name.length > 80 ? `${name.slice(0, 80)}…` : name;
  }
  return entry.project_name
    ? `${entry.project_name} · ${shortId(entry.worker_id)}`
    : shortId(entry.worker_id);
}

function buildSubline(entry: WorkerHistoryEntry): string {
  const parts: string[] = [];
  if (entry.project_name) parts.push(entry.project_name);
  if (entry.git_branch) parts.push(entry.git_branch);
  if (entry.message_count && entry.message_count > 0) parts.push(`${entry.message_count} msgs`);
  return parts.join(' · ');
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type SortDir = 'desc' | 'asc';
const SORT_STORAGE_KEY = 'flowpad.historyModal.sortDir';
function readStoredSortDir(): SortDir {
  if (typeof window === 'undefined') return 'desc';
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY) === 'asc' ? 'asc' : 'desc';
  } catch {
    return 'desc';
  }
}

function WorkerIcon({ workerType }: { workerType: WorkerHistoryEntry['worker_type'] }) {
  if (workerType === 'codex') {
    return <CodexIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  }
  return <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />;
}

interface HistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (entry: WorkerHistoryEntry) => void;
}

function entryKey(entry: WorkerHistoryEntry): string {
  return `${entry.worker_type}:${entry.worker_id}`;
}

export function HistoryModal({ open, onOpenChange, onSelect }: HistoryModalProps) {
  const { entries, isLoading } = useWorkerHistory(30, { enabled: open });
  const { navigation } = useDockNavigation();
  const { project: currentProject } = useProject();

  const [allProjects, setAllProjects] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const [peekProcess, setPeekProcess] = useState<AgenticProcess | null>(null);
  const [peekResolving, setPeekResolving] = useState(false);
  const [sortDir, setSortDir] = useState<SortDir>(readStoredSortDir);

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, sortDir);
    } catch {
      // localStorage may be unavailable (private mode, quota, etc.) — preference simply doesn't persist.
    }
  }, [sortDir]);

  // Reset selection + peek when modal closes so a new open starts clean.
  useEffect(() => {
    if (!open) {
      setSelectedKeys(new Set());
      setPeekKey(null);
      setPeekProcess(null);
    }
  }, [open]);

  const visible = useMemo(() => {
    const currentProjectId = currentProject?.id ?? null;
    const filtered = allProjects
      ? entries
      : entries.filter(
          (e) => currentProjectId != null && e.project_id === currentProjectId,
        );
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const ta = a.last_active_time ? Date.parse(a.last_active_time) : 0;
      const tb = b.last_active_time ? Date.parse(b.last_active_time) : 0;
      return sortDir === 'desc' ? tb - ta : ta - tb;
    });
    return sorted;
  }, [entries, allProjects, currentProject?.id, sortDir]);

  // Drop selections that are no longer visible after a filter change.
  useEffect(() => {
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const visibleKeys = new Set(visible.map(entryKey));
      const next = new Set<string>();
      for (const k of prev) if (visibleKeys.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleOpenAllSelected = () => {
    const byKey = new Map(visible.map((e) => [entryKey(e), e] as const));
    for (const k of selectedKeys) {
      const entry = byKey.get(k);
      if (entry) onSelect(entry);
    }
    setSelectedKeys(new Set());
  };

  // Resolve an AgenticProcess for the peek target. Mirrors the path
  // TabbedTerminal uses for "Open from history" — agentic_process_id wins
  // when present, otherwise the idempotent upsert via fromClaude/CodexSession.
  const peekEntry = useMemo(
    () => (peekKey ? visible.find((e) => entryKey(e) === peekKey) ?? null : null),
    [peekKey, visible],
  );
  useEffect(() => {
    if (!peekEntry) {
      setPeekProcess(null);
      setPeekResolving(false);
      return;
    }
    let cancelled = false;
    setPeekResolving(true);
    setPeekProcess(null);
    const resolve = async () => {
      let p: AgenticProcess | null = null;
      // Try the cached id first; fall through silently if the record was
      // pruned (worker history outlives agentic_process rows).
      if (peekEntry.agentic_process_id) {
        try {
          p = (await AgenticProcess.getById(peekEntry.agentic_process_id)) ?? null;
        } catch {
          p = null;
        }
      }
      if (!p) {
        try {
          p =
            peekEntry.worker_type === 'codex'
              ? await AgenticProcess.fromCodexSession(
                  peekEntry.worker_id,
                  peekEntry.project_cwd ?? undefined,
                  peekEntry.project_id ?? undefined,
                )
              : await AgenticProcess.fromClaudeSession(
                  peekEntry.worker_id,
                  peekEntry.project_cwd ?? undefined,
                  peekEntry.project_id ?? undefined,
                );
        } catch (err) {
          console.error('[HistoryModal] Failed to resolve process for peek:', err);
          p = null;
        }
      }
      if (!cancelled) {
        setPeekProcess(p);
        setPeekResolving(false);
      }
    };
    void resolve();
    return () => { cancelled = true; };
  }, [peekEntry]);

  const { promptEntries: peekPromptEntries, isLoading: peekPromptsLoading } =
    usePromptsForProcess(peekProcess);

  const togglePeek = (key: string) => {
    setPeekKey((prev) => (prev === key ? null : key));
  };

  const peeking = peekKey != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex w-full flex-col overflow-hidden p-4 max-h-[80vh] transition-[max-width] duration-200',
          peeking ? 'sm:max-w-2xl' : 'sm:max-w-sm',
        )}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-7">
            <div className="flex items-center gap-3">
              <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
              <label
                className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground select-none"
                title={currentProject ? undefined : 'No active project'}
                data-testid="history-all-projects"
              >
                <Checkbox
                  className="h-3 w-3"
                  checked={allProjects}
                  onCheckedChange={(v) => setAllProjects(v === true)}
                  disabled={!currentProject}
                />
                <span>All projects</span>
              </label>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title={
                  sortDir === 'desc'
                    ? 'Sort by time: newest first (click for oldest first)'
                    : 'Sort by time: oldest first (click for newest first)'
                }
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                data-testid="history-sort-time"
                aria-label="Sort by time"
              >
                {sortDir === 'desc' ? (
                  <ArrowDown className="h-3.5 w-3.5" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                title="Search all sessions"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  onOpenChange(false);
                  navigation.openSearch();
                }}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </DialogHeader>
        {selectedKeys.size > 0 && (
          <div
            className="mt-1 flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1"
            data-testid="history-selection-bar"
          >
            <span className="text-[11px] text-muted-foreground">
              {selectedKeys.size} selected
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedKeys(new Set())}
                className="rounded border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-muted"
                data-testid="history-clear-selection"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleOpenAllSelected}
                className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
                data-testid="history-open-selected"
              >
                Open all
              </button>
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {isLoading && visible.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
            ) : visible.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No recent sessions</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5 overflow-y-auto">
                <TooltipProvider delayDuration={400}>
                  {visible.map((entry) => {
                    const subline = buildSubline(entry);
                    const key = entryKey(entry);
                    const selected = selectedKeys.has(key);
                    const isPeeking = peekKey === key;
                    return (
                      <li
                        key={key}
                        className={cn(
                          'flex min-w-0 items-center gap-1.5 rounded pl-1 hover:bg-muted',
                          isPeeking && 'bg-muted',
                        )}
                        data-testid="history-row"
                      >
                        <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={selected}
                            onCheckedChange={() => toggleSelected(key)}
                            aria-label="Select session"
                            data-testid="history-row-checkbox"
                          />
                        </span>
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded px-1.5 py-1.5 text-left text-sm"
                          onClick={() => onSelect(entry)}
                        >
                          <WorkerIcon workerType={entry.worker_type} />
                          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="truncate font-medium">{pickLabelFallback(entry)}</span>
                            {subline ? (
                              <span className="truncate text-xs text-muted-foreground">{subline}</span>
                            ) : null}
                          </span>
                          <span
                            className="ml-2 flex shrink-0 flex-col items-end leading-tight text-muted-foreground"
                            data-testid="history-row-time"
                          >
                            <span className="text-xs">{timeAgo(entry.last_active_time)}</span>
                            <span className="text-[10px] opacity-70">
                              {formatFullDate(entry.last_active_time)}
                            </span>
                          </span>
                        </button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                'mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground',
                                isPeeking && 'bg-muted-foreground/10 text-foreground',
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePeek(key);
                              }}
                              data-testid="history-row-prompts-button"
                              aria-label="Prompts list"
                            >
                              <MessageSquare className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left">Prompts list</TooltipContent>
                        </Tooltip>
                      </li>
                    );
                  })}
                </TooltipProvider>
              </ul>
            )}
          </div>
          {peeking && (
            <SideDrawer
              open
              onOpenChange={(v) => { if (!v) setPeekKey(null); }}
              title="Prompts"
              count={peekPromptEntries.length}
              width="w-72"
              data-testid="history-prompts-peek"
            >
              <div className="flex h-full min-h-0 flex-col">
                {peekResolving || (peekPromptsLoading && peekPromptEntries.length === 0) ? (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">Loading prompts…</p>
                ) : peekPromptEntries.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">No prompts found</p>
                ) : (
                  <PromptIndexPanel prompts={peekPromptEntries} onScrollToLine={() => {}} />
                )}
              </div>
            </SideDrawer>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
