import { AgenticProcess } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Checkbox } from '@src/components/ui/checkbox';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { PromptIndexPanel, usePromptsForProcess } from '@src/components/terminal/interactive-terminal/side-windows';
import { cn } from '@src/lib/utils';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useProject } from '@src/hooks/useProject';
import { ArrowDown, ArrowUp, MessageSquare, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickName(entry: WorkerHistoryEntry): string | null {
  const name = (entry.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== entry.worker_id) {
    return name.length > 80 ? `${name.slice(0, 80)}…` : name;
  }
  return null;
}

function buildMetaSubline(entry: WorkerHistoryEntry): string {
  const parts: string[] = [];
  if (entry.project_name) parts.push(entry.project_name);
  if (entry.git_branch) parts.push(entry.git_branch);
  if (entry.message_count && entry.message_count > 0) parts.push(`${entry.message_count} msgs`);
  return parts.join(' · ');
}

function pickLastPrompt(entry: WorkerHistoryEntry): string | null {
  const v = (entry.last_prompt ?? '').trim();
  return v ? v : null;
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
const ALL_PROJECTS_STORAGE_KEY = 'flowpad.historyModal.allProjects';

// localStorage-backed useState. `parse` maps the raw stored value (null when
// absent/unavailable) to the typed value, doubling as the default.
function usePersistedState<T extends string | boolean>(
  key: string,
  parse: (raw: string | null) => T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return parse(null);
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // localStorage may be unavailable (private mode, quota, etc.) — preference simply doesn't persist.
    }
  }, [key, value]);
  return [value, setValue];
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
  const { project: currentProject } = useProject();

  const [allProjects, setAllProjects] = usePersistedState(ALL_PROJECTS_STORAGE_KEY, (raw) => raw === 'true');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const [peekProcess, setPeekProcess] = useState<AgenticProcess | null>(null);
  const [peekResolving, setPeekResolving] = useState(false);
  const [sortDir, setSortDir] = usePersistedState<SortDir>(SORT_STORAGE_KEY, (raw) => (raw === 'asc' ? 'asc' : 'desc'));
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // No active project → nothing to scope to; behave as "all projects".
  const effectiveAllProjects = allProjects || !currentProject;

  // Reset selection + peek + search when modal closes so a new open starts clean.
  useEffect(() => {
    if (!open) {
      setSelectedKeys(new Set());
      setPeekKey(null);
      setPeekProcess(null);
      setSearchOpen(false);
      setQuery('');
    }
  }, [open]);

  // Autofocus the input the moment the search box is revealed.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const visible = useMemo(() => {
    const currentProjectId = currentProject?.id ?? null;
    const projectScoped = effectiveAllProjects ? entries : entries.filter((e) => e.project_id === currentProjectId);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projectScoped.filter((e) => {
          const hay = [e.name, e.last_prompt, e.project_name].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(q);
        })
      : projectScoped;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const ta = a.last_active_time ? Date.parse(a.last_active_time) : 0;
      const tb = b.last_active_time ? Date.parse(b.last_active_time) : 0;
      return sortDir === 'desc' ? tb - ta : ta - tb;
    });
    return sorted;
  }, [entries, effectiveAllProjects, currentProject?.id, sortDir, query]);

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
    () => (peekKey ? (visible.find((e) => entryKey(e) === peekKey) ?? null) : null),
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
          p = await AgenticProcess.getByWorkerId(peekEntry.worker_id);
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
    return () => {
      cancelled = true;
    };
  }, [peekEntry]);

  const { promptEntries: peekPromptEntries, isLoading: peekPromptsLoading } = usePromptsForProcess(peekProcess);

  const togglePeek = (key: string) => {
    setPeekKey((prev) => (prev === key ? null : key));
  };

  const peeking = peekKey != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex max-h-[80vh] w-full flex-col overflow-hidden p-4 transition-[max-width] duration-200',
          peeking ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
        onEscapeKeyDown={(e) => {
          // When the inline filter is open, Esc clears/closes it instead of
          // dismissing the whole modal — preventDefault here tells Radix's
          // dismissable layer to not run its onOpenChange(false).
          if (searchOpen) {
            e.preventDefault();
            if (query) setQuery('');
            else setSearchOpen(false);
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-7">
            <div className="flex items-center gap-3">
              <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
              <label
                className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-muted-foreground"
                title={currentProject ? undefined : 'No active project'}
                data-testid="history-all-projects"
              >
                <Checkbox
                  className="h-3 w-3"
                  checked={effectiveAllProjects}
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
                {sortDir === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                title="Filter recent sessions"
                aria-label="Filter recent sessions"
                aria-pressed={searchOpen}
                data-testid="history-search-toggle"
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground',
                  searchOpen && 'bg-muted text-foreground',
                )}
                onClick={() => {
                  setSearchOpen((v) => {
                    const next = !v;
                    if (!next) setQuery('');
                    return next;
                  });
                }}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </DialogHeader>
        {searchOpen && (
          <div
            className="mt-1 flex items-center gap-1 rounded border border-input bg-background px-2"
            data-testid="history-search-bar"
          >
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or last prompt…"
              className="h-7 w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
              data-testid="history-search-input"
            />
            {query && (
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear filter"
                aria-label="Clear filter"
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
                data-testid="history-search-clear"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
        {/* Always rendered (invisible when empty) so the first selection doesn't shift the list. */}
        <div
          className={cn(
            'mt-1 flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1',
            selectedKeys.size === 0 && 'invisible',
          )}
          data-testid="history-selection-bar"
        >
          <span className="text-[11px] text-muted-foreground">{selectedKeys.size} selected</span>
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
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {isLoading && visible.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
            ) : visible.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {query.trim() ? 'No matching sessions' : 'No recent sessions'}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5 overflow-y-auto">
                <TooltipProvider delayDuration={400}>
                  {visible.map((entry) => {
                    const meta = buildMetaSubline(entry);
                    const lastPrompt = pickLastPrompt(entry);
                    const key = entryKey(entry);
                    const selected = selectedKeys.has(key);
                    const isPeeking = peekKey === key;
                    const name = pickName(entry);
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
                          onClick={() => {
                            if (peeking) {
                              // Detailed mode: click only changes the previewed row.
                              setPeekKey(key);
                            } else {
                              // Compact mode: click opens the session.
                              onSelect(entry);
                            }
                          }}
                          onDoubleClick={() => {
                            // Detailed mode only — double-click commits to opening.
                            if (peeking) onSelect(entry);
                          }}
                        >
                          <WorkerIcon workerType={entry.worker_type} />
                          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            {name ? (
                              <>
                                <span className="truncate font-medium text-foreground">{name}</span>
                                {lastPrompt ? (
                                  <span
                                    className="truncate text-xs italic text-muted-foreground"
                                    data-testid="history-row-last-prompt"
                                  >
                                    &ldquo;{lastPrompt}&rdquo;
                                  </span>
                                ) : null}
                              </>
                            ) : lastPrompt ? (
                              <span
                                className="truncate text-sm italic text-muted-foreground"
                                data-testid="history-row-last-prompt"
                              >
                                &ldquo;{lastPrompt}&rdquo;
                              </span>
                            ) : (
                              <span className="truncate font-medium italic text-muted-foreground/60">
                                Untitled session
                              </span>
                            )}
                            {meta ? (
                              <span className="truncate text-[10px] text-muted-foreground/70">{meta}</span>
                            ) : null}
                          </span>
                          <span
                            className="ml-2 flex shrink-0 flex-col items-end leading-tight text-muted-foreground"
                            data-testid="history-row-time"
                          >
                            <span className="text-xs">{timeAgo(entry.last_active_time)}</span>
                            <span className="text-[10px] opacity-70">{formatFullDate(entry.last_active_time)}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={cn(
                            'mr-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium shadow-sm transition-colors',
                            isPeeking
                              ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                              : 'border-border bg-background text-foreground hover:border-muted-foreground/40 hover:bg-muted-foreground/10 hover:text-foreground',
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePeek(key);
                          }}
                          data-testid="history-row-prompts-button"
                        >
                          <MessageSquare className="h-3 w-3" />
                          <span>Prompts</span>
                        </button>
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
              onOpenChange={(v) => {
                if (!v) setPeekKey(null);
              }}
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
                  <PromptIndexPanel
                    prompts={peekPromptEntries}
                    onScrollToLine={() => {}}
                    process={peekProcess}
                    projectId={peekProcess?.project_id ?? null}
                  />
                )}
              </div>
            </SideDrawer>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
