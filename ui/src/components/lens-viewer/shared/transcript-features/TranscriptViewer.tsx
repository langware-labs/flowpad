import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileText,
  Info,
  Loader2,
  Terminal,
} from 'lucide-react';

import { AgenticProcess } from '@sdk';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { toast } from '@src/hooks/use-toast';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTranscript, type WorkerType } from '@src/hooks/use-transcript';

import { ViewModeToggle } from '../ViewModeToggle';
import { useTranscriptMode } from '../use-transcript-mode';
import { ChatEntryItem } from './ChatEntryItem';
import { TranscriptEntryItem } from './TranscriptEntryItem';
import { TranscriptStats } from './TranscriptStats';
import { groupEntriesByTurn } from './group-entries';
import { collectToolKeys, formatAgo, formatDuration, operationFilterKey, resolveEntryTimestamp } from './transcript-utils';
import type { UnifiedEntry } from './types';

interface Props {
  workerType: WorkerType;
  /** Absolute filesystem path to the JSONL transcript. Provide this OR sessionId. */
  path?: string;
  /** Session id; the server resolves the on-disk path via the worker route. */
  sessionId?: string;
  selectedEntryId?: string;
  selectedTimestamp?: string;
}

/**
 * Worker-agnostic rich transcript viewer. Both Claude and Codex sessions go
 * through this — the data shape is `UnifiedEntry[]`, projected from the
 * server-emitted `GenericEntry[]` by `groupEntriesByTurn`.
 *
 * Features (parity with the legacy claude viewer):
 *   - Chat / Transcript mode toggle.
 *   - Top scroll-position clock (start · current · duration · end).
 *   - URL anchoring (`transcript_entry_id`, `ts`) + scroll-to-entry.
 *   - Mode-switch viewport preservation.
 *   - Per-tool / per-role filters + free-text search.
 *   - Expand all / collapse all (chat).
 *   - Per-entry expand / collapse + JSON info dialog.
 *   - Path bar with copy-to-clipboard.
 */
export function TranscriptViewer({ workerType, path, sessionId: sessionIdProp, selectedEntryId, selectedTimestamp }: Props) {
  const { navigation } = useDockNavigation();
  const [, setSearchParams] = useSearchParams();
  const { data, isLoading, error } = useTranscript({ workerType, path, sessionId: sessionIdProp });

  const entries = useMemo<UnifiedEntry[]>(() => (data ? groupEntriesByTurn(data.entries) : []), [data]);
  const sessionId = data?.session_id ?? null;
  const header = data?.header ?? {};

  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [chatExpandedEntries, setChatExpandedEntries] = useState<Set<string>>(new Set());
  const [showUser, setShowUser] = useState(true);
  const [showAssistant, setShowAssistant] = useState(true);
  const [toolFilters, setToolFilters] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [infoEntry, setInfoEntry] = useState<UnifiedEntry | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoHoverTimerRef = useRef<number | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  // ── Scroll sync refs ──────────────────────────────────────────────────────
  const internalTimestampRef = useRef<string | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTargetRef = useRef<HTMLDivElement>(null);
  const displayTimerRef = useRef<number | null>(null);
  const urlUpdatedByScrollRef = useRef(false);

  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const [displayTimestamp, setDisplayTimestamp] = useState<string | null>(null);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);

  const [viewMode, setViewMode] = useTranscriptMode();

  // ── Initialize tool filters on first load (run once per `entries` identity) ─
  const initializedForRef = useRef<UnifiedEntry[] | null>(null);
  useEffect(() => {
    if (!entries.length) return;
    if (initializedForRef.current === entries) return;
    initializedForRef.current = entries;

    const initial: Record<string, boolean> = {};
    collectToolKeys(entries).forEach((n) => { initial[n] = true; });
    setToolFilters(initial);

    for (const entry of entries) {
      const ts = resolveEntryTimestamp(entry);
      if (ts) {
        internalTimestampRef.current = ts;
        setDisplayTimestamp(ts);
        setCurrentEntryId(entry.id);
        break;
      }
    }
  }, [entries]);

  // First / last timestamps
  const transcriptStartTs = useMemo(() => {
    for (const e of entries) {
      const ts = resolveEntryTimestamp(e);
      if (ts) return ts;
    }
    return null;
  }, [entries]);
  const transcriptEndTs = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const ts = resolveEntryTimestamp(entries[i]);
      if (ts) return ts;
    }
    return null;
  }, [entries]);

  // Resolve a copyable path string. When opened by session_id only, fall back
  // to the parsed transcript's path (server populates it on the response).
  const copyablePath = path ?? data?.path ?? '';
  const handleCopyPath = useCallback(() => {
    if (!copyablePath) return;
    void navigator.clipboard.writeText(copyablePath).then(() => {
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    });
  }, [copyablePath]);

  // ── Resolved entry for URL-param highlight ────────────────────────────────
  const resolvedEntryId = useMemo(() => {
    if (!entries.length) return undefined;
    if (selectedEntryId) {
      const found = entries.find((e) => e.id === selectedEntryId);
      if (found) return found.id;
    }
    if (selectedTimestamp) {
      const targetMs = new Date(selectedTimestamp).getTime();
      if (Number.isNaN(targetMs)) return undefined;
      let best: UnifiedEntry | null = null;
      let bestDiff = Infinity;
      for (const entry of entries) {
        const ts = resolveEntryTimestamp(entry);
        if (!ts) continue;
        const diff = Math.abs(new Date(ts).getTime() - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
      }
      return best?.id;
    }
    return undefined;
  }, [entries, selectedEntryId, selectedTimestamp]);

  // ── Trigger initial scroll when URL-param entry resolves ─────────────────
  useEffect(() => {
    if (resolvedEntryId) {
      if (urlUpdatedByScrollRef.current) {
        urlUpdatedByScrollRef.current = false;
        return;
      }
      setPendingScrollId(resolvedEntryId);
      setExpandedEntries((prev) => prev.has(resolvedEntryId) ? prev : new Set([...prev, resolvedEntryId]));
      setChatExpandedEntries((prev) => prev.has(resolvedEntryId) ? prev : new Set([...prev, resolvedEntryId]));
    }
  }, [resolvedEntryId]);

  // ── Scroll-to effect ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!pendingScrollId || !entries.length) return;
    if (viewMode === 'trace') {
      setExpandedEntries((prev) => {
        if (prev.has(pendingScrollId)) return prev;
        const next = new Set(prev);
        next.add(pendingScrollId);
        return next;
      });
    }
    const targetEntry = entries.find((e) => e.id === pendingScrollId);
    const targetTs = targetEntry ? resolveEntryTimestamp(targetEntry) : null;
    if (targetTs) {
      internalTimestampRef.current = targetTs;
      setDisplayTimestamp(targetTs);
      setCurrentEntryId(pendingScrollId);
    }
    isProgrammaticScrollRef.current = true;
    const container = containerRef.current;
    const clearProgrammatic = () => {
      isProgrammaticScrollRef.current = false;
      setPendingScrollId(null);
      container?.removeEventListener('scrollend', clearProgrammatic);
      clearTimeout(fallbackTimer);
    };
    const t1 = setTimeout(() => {
      scrollTargetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    const fallbackTimer = setTimeout(clearProgrammatic, 1500);
    container?.addEventListener('scrollend', clearProgrammatic, { once: true });
    return () => {
      clearTimeout(t1);
      clearTimeout(fallbackTimer);
      container?.removeEventListener('scrollend', clearProgrammatic);
    };
  }, [pendingScrollId, entries, viewMode]);

  // ── Scroll listener ───────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (isProgrammaticScrollRef.current) return;
      const containerTop = container.getBoundingClientRect().top;
      const elems = container.querySelectorAll<HTMLElement>('[data-entry-ts]');
      let bestEl: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const el of elems) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < containerTop) continue;
        const dist = rect.top - containerTop;
        if (dist >= 0 && dist < bestDist) { bestDist = dist; bestEl = el; }
      }
      if (bestEl) {
        const ts = bestEl.getAttribute('data-entry-ts');
        const id = bestEl.getAttribute('data-entry-uuid');
        if (ts) {
          internalTimestampRef.current = ts;
          if (displayTimerRef.current) clearTimeout(displayTimerRef.current);
          displayTimerRef.current = window.setTimeout(() => {
            setDisplayTimestamp(ts);
            if (id) {
              setCurrentEntryId(id);
              urlUpdatedByScrollRef.current = true;
              setSearchParams((prev) => { prev.set('transcript_entry_id', id); return prev; }, { replace: true });
            }
          }, 150);
        }
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, isLoading]);

  // ── Mode switch with viewport preservation ────────────────────────────────
  const switchMode = (newMode: 'chat' | 'trace') => {
    if (newMode === viewMode) return;
    isProgrammaticScrollRef.current = true;
    const anchorEntry = currentEntryId ? entries.find((e) => e.id === currentEntryId) ?? null : null;
    const anchorTs = anchorEntry ? resolveEntryTimestamp(anchorEntry) : internalTimestampRef.current;
    if (anchorTs) {
      const targetMs = new Date(anchorTs).getTime();
      if (!Number.isNaN(targetMs)) {
        const candidates = newMode === 'chat'
          ? entries.filter((e) => e.role === 'user' || e.role === 'assistant')
          : entries;
        let best: UnifiedEntry | null = null;
        let bestDiff = Infinity;
        for (const entry of candidates) {
          const ts = resolveEntryTimestamp(entry);
          if (!ts) continue;
          const diff = Math.abs(new Date(ts).getTime() - targetMs);
          if (diff < bestDiff) { bestDiff = diff; best = entry; }
        }
        if (best) {
          setPendingScrollId(best.id);
          setSearchParams((prev) => { prev.set('transcript_entry_id', best!.id); return prev; }, { replace: true });
        }
      }
    }
    internalTimestampRef.current = null;
    setViewMode(newMode);
  };

  // ── Filters & search ──────────────────────────────────────────────────────
  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (entry.role === 'user') {
        if (!showUser) return false;
        return !query || entry.searchHaystack.includes(query);
      }
      if (entry.role === 'operation' && entry.operation) {
        if (!showAssistant) return false;
        if (toolFilters[operationFilterKey(entry.operation)] === false) return false;
        return !query || entry.searchHaystack.includes(query);
      }
      if (entry.role === 'assistant') {
        if (!showAssistant) return false;
        return !query || entry.searchHaystack.includes(query);
      }
      // System / meta / summary / unknown
      if (!showUser && !showAssistant) return false;
      return !query || entry.searchHaystack.includes(query);
    });
  }, [entries, showUser, showAssistant, toolFilters, searchQuery]);

  // Chat mode is a quick agent ↔ user view. Operations (tool calls / file
  // writes / shell commands) live in trace mode only — chat stays simple.
  const chatEntries = useMemo(
    () => filteredEntries.filter((e) => {
      if (e.role === 'assistant') {
        return !!(e.text || e.thinking);
      }
      if (e.role === 'user') {
        return !!(e.text && e.text.trim().length);
      }
      return false;
    }),
    [filteredEntries],
  );

  const toggleToolFilter = (toolName: string) => {
    setToolFilters((prev) => ({ ...prev, [toolName]: !prev[toolName] }));
  };

  const clearAllFilters = () => {
    setToolFilters((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, true])));
    setShowUser(true);
    setShowAssistant(true);
    setSearchQuery('');
  };

  const disableAllFilters = () => {
    setToolFilters((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, false])));
    setShowUser(false);
    setShowAssistant(false);
  };

  const handleOpenInTerminal = useCallback(() => {
    if (!sessionId) return;
    void (async () => {
      const process = await AgenticProcess.getByWorkerId(sessionId).catch(() => null);
      if (!process) {
        toast({ title: 'Process not found', description: `No live process for session ${sessionId}.`, variant: 'destructive' });
        return;
      }
      navigation.openDockPointer(process.terminalDockPointer);
    })();
  }, [navigation, sessionId]);

  const handleOpenTasksOverview = useMemo(() => {
    if (workerType !== 'claude' || !sessionId) return undefined;
    return () => navigation.openLens('claude', 'tasks', sessionId);
  }, [navigation, sessionId, workerType]);

  const toggleEntry = (id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSearchParams((prev) => { prev.set('transcript_entry_id', id); return prev; }, { replace: true });
  };
  const toggleChatEntry = (id: string) => {
    setChatExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const expandAllChat = () => {
    setChatExpandedEntries(new Set(entries.filter((e) => e.role === 'user' || e.role === 'assistant').map((e) => e.id)));
  };
  const collapseAllChat = () => setChatExpandedEntries(new Set());

  // Info modal helpers
  const openInfo = (entry: UnifiedEntry) => {
    if (infoHoverTimerRef.current) { window.clearTimeout(infoHoverTimerRef.current); infoHoverTimerRef.current = null; }
    setInfoEntry(entry);
    setInfoOpen(true);
  };
  const scheduleInfoOpen = (entry: UnifiedEntry) => {
    if (infoHoverTimerRef.current) window.clearTimeout(infoHoverTimerRef.current);
    infoHoverTimerRef.current = window.setTimeout(() => {
      infoHoverTimerRef.current = null;
      setInfoEntry(entry);
      setInfoOpen(true);
    }, 3000);
  };
  const cancelInfoOpen = () => {
    if (!infoHoverTimerRef.current) return;
    window.clearTimeout(infoHoverTimerRef.current);
    infoHoverTimerRef.current = null;
  };

  // ── Loading / error / empty ───────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-destructive">
        <div className="text-center">
          <p className="font-medium">Error Loading Transcript</p>
          <p className="mt-1 text-sm">{error.message}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{path}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        <p>No transcript data</p>
      </div>
    );
  }

  const infoDialog = (
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            Entry details
          </DialogTitle>
        </DialogHeader>
        {infoEntry && (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => { void navigator.clipboard.writeText(JSON.stringify(infoEntry, null, 2)); }}
              >
                Copy entry
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify({
                    path,
                    session_id: sessionId,
                    entry: infoEntry,
                    filters: { show_user: showUser, show_assistant: showAssistant, tool_filters: toolFilters, search_query: searchQuery },
                  }, null, 2));
                }}
              >
                Copy all
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-all rounded border border-border bg-muted/30 p-3 font-mono text-[11px]">
              {JSON.stringify(infoEntry, null, 2)}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Top bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <ViewModeToggle mode={viewMode} onChange={switchMode} />

        {/* Scroll-position clock */}
        <div className="flex flex-1 items-center justify-center gap-0 text-[11px] tabular-nums">
          {transcriptStartTs && (
            <span
              className="text-muted-foreground/50 text-[10px]"
              title={`Session start\n${new Date(transcriptStartTs).toLocaleString()}\n${formatAgo(transcriptStartTs)}`}
            >
              {new Date(transcriptStartTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {transcriptStartTs && <span className="mx-2 text-border">·····</span>}
          {displayTimestamp ? (
            <span
              className="flex items-center gap-1.5"
              title={`${new Date(displayTimestamp).toLocaleString()}\n${formatAgo(displayTimestamp)}`}
            >
              <span className="font-medium text-foreground">{new Date(displayTimestamp).toLocaleTimeString()}</span>
              <span className="text-border/60">·</span>
              <span className="text-muted-foreground">{formatAgo(displayTimestamp)}</span>
              {transcriptStartTs && (() => {
                const diff = new Date(displayTimestamp).getTime() - new Date(transcriptStartTs).getTime();
                return diff > 0 ? (
                  <>
                    <span className="text-border/60">·</span>
                    <span className="text-muted-foreground/70">+{formatDuration(diff)}</span>
                  </>
                ) : null;
              })()}
            </span>
          ) : (
            <span className="text-muted-foreground/30 text-[10px]">scroll to navigate</span>
          )}
          {transcriptEndTs && <span className="mx-2 text-border">·····</span>}
          {transcriptEndTs && (
            <span
              className="text-muted-foreground/50 text-[10px]"
              title={`Session end\n${new Date(transcriptEndTs).toLocaleString()}\n${formatAgo(transcriptEndTs)}`}
            >
              {new Date(transcriptEndTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {sessionId && (
          <div className="flex items-center gap-1" data-testid="transcript-viewer-toolbar">
            <button
              type="button"
              onClick={handleOpenInTerminal}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Open in terminal"
              data-testid="transcript-open-in-terminal"
            >
              <Terminal className="h-3 w-3" />
              Open in terminal
            </button>
          </div>
        )}

        {viewMode === 'chat' && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={expandAllChat}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronsUpDown className="h-3 w-3" />
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAllChat}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronsDownUp className="h-3 w-3" />
              Collapse all
            </button>
          </div>
        )}
      </div>

      {viewMode === 'chat' ? (
        <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          {chatEntries.map((entry, idx) => {
            const ts = resolveEntryTimestamp(entry);
            const isSelected = entry.id === resolvedEntryId;
            const isCurrent = entry.id === currentEntryId && !isSelected;
            return (
              <div
                key={`${entry.id}:${idx}`}
                ref={entry.id === pendingScrollId ? scrollTargetRef : undefined}
                data-entry-ts={ts ?? undefined}
                data-entry-uuid={entry.id}
                className={
                  isSelected ? 'bg-primary/5 ring-1 ring-inset ring-primary/30'
                  : isCurrent ? 'border-l-[3px] border-primary/40 bg-muted/20'
                  : undefined
                }
                onClick={() => {
                  if (!ts) return;
                  internalTimestampRef.current = ts;
                  setDisplayTimestamp(ts);
                  setCurrentEntryId(entry.id);
                  urlUpdatedByScrollRef.current = true;
                  setSearchParams((prev) => { prev.set('transcript_entry_id', entry.id); return prev; }, { replace: true });
                }}
              >
                <ChatEntryItem
                  entry={entry}
                  isExpanded={chatExpandedEntries.has(entry.id)}
                  onToggle={() => toggleChatEntry(entry.id)}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <TranscriptStats
            entries={entries}
            sessionId={sessionId}
            header={header}
            showUser={showUser}
            showAssistant={showAssistant}
            toolFilters={toolFilters}
            onToggleUser={() => setShowUser((p) => !p)}
            onToggleAssistant={() => setShowAssistant((p) => !p)}
            onToggleTool={toggleToolFilter}
            onClearFilters={clearAllFilters}
            onDisableAll={disableAllFilters}
            onOpenTasks={handleOpenTasksOverview}
          />

          <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1">
            <FileText className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span className="truncate font-mono text-[10px] text-muted-foreground" title={path}>{path}</span>
            <button
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={handleCopyPath}
              title="Copy transcript path"
            >
              {copiedPath ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>

          <div className="flex shrink-0 items-center border-b border-border bg-card px-3 py-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search transcript…"
              className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
            />
          </div>

          <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
            {filteredEntries.map((entry, idx) => {
              const ts = resolveEntryTimestamp(entry);
              const isSelected = entry.id === resolvedEntryId;
              const isCurrent = entry.id === currentEntryId && !isSelected;
              return (
                <div
                  key={`${entry.id}:${idx}`}
                  ref={entry.id === pendingScrollId ? scrollTargetRef : undefined}
                  data-entry-ts={ts ?? undefined}
                  data-entry-uuid={entry.id}
                  className={
                    isSelected ? 'rounded bg-primary/10 ring-1 ring-primary'
                    : isCurrent ? 'border-l-[3px] border-primary/40 bg-muted/20'
                    : undefined
                  }
                  onClick={() => {
                    if (!ts) return;
                    internalTimestampRef.current = ts;
                    setDisplayTimestamp(ts);
                    setCurrentEntryId(entry.id);
                    urlUpdatedByScrollRef.current = true;
                    setSearchParams((prev) => { prev.set('transcript_entry_id', entry.id); return prev; }, { replace: true });
                  }}
                >
                  <TranscriptEntryItem
                    entry={entry}
                    isExpanded={expandedEntries.has(entry.id)}
                    onToggle={() => toggleEntry(entry.id)}
                    toolFilters={toolFilters}
                    onInfo={() => openInfo(entry)}
                    onInfoHover={() => scheduleInfoOpen(entry)}
                    onInfoHoverEnd={cancelInfoOpen}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {infoDialog}
    </div>
  );
}
