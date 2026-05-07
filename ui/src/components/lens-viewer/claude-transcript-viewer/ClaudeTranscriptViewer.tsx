import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  dataContext,
  fsManager,
  parseTranscript,
  type ParsedTranscript,
  type TranscriptEntry,
  isAssistantEntry,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isUserEntry,
} from '@sdk';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { toast } from '@src/hooks/use-toast';
import { TranscriptStats } from './TranscriptStats';
import { TranscriptEntryItem } from './TranscriptEntryItem';
import { ChatEntryItem } from './ChatEntryItem';
import { ViewModeToggle } from './ViewModeToggle';
import { useTranscriptMode } from './use-transcript-mode';
import { resolveEntryTimestamp, formatAgo, formatDuration } from './transcript-utils';

interface Props {
  projectEncodedName: string;
  sessionId: string;
  selectedEntryId?: string;
  selectedTimestamp?: string;
}

export function ClaudeTranscriptViewer({ projectEncodedName, sessionId, selectedEntryId, selectedTimestamp }: Props) {
  const { navigation } = useDockNavigation();
  const [, setSearchParams] = useSearchParams();
  const [transcript, setTranscript] = useState<ParsedTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [chatExpandedEntries, setChatExpandedEntries] = useState<Set<string>>(new Set());
  const [showUser, setShowUser] = useState(true);
  const [showAssistant, setShowAssistant] = useState(true);
  const [toolFilters, setToolFilters] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [infoEntry, setInfoEntry] = useState<TranscriptEntry | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoHoverTimerRef = useRef<number | null>(null);

  // ── Scroll sync refs ──────────────────────────────────────────────────────
  // Updated by the scroll listener (plain ref → no re-renders, no loop risk)
  const internalTimestampRef = useRef<string | null>(null);
  // Set to true during programmatic scroll so the scroll listener ignores those events
  const isProgrammaticScrollRef = useRef(false);
  // The scroll container for the active view; listener is attached here
  const containerRef = useRef<HTMLDivElement>(null);
  // The entry element to scroll into view
  const scrollTargetRef = useRef<HTMLDivElement>(null);
  // Debounce timer for display-only timestamp state
  const displayTimerRef = useRef<number | null>(null);
  // Set to true when the URL is updated by the scroll listener, so the
  // resolvedEntryId effect skips scroll restoration (prevents feedback loop)
  const urlUpdatedByScrollRef = useRef(false);

  // pendingScrollId drives the scroll effect.
  // Only set by: initial URL param resolution, or switchMode().
  // Cleared automatically after the scroll animation completes.
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);

  // Display-only timestamp — drives the top bar clock. Updated by scroll listener
  // (debounced) and by programmatic scroll. Separate from internalTimestampRef so
  // display updates don't trigger any scroll logic.
  const [displayTimestamp, setDisplayTimestamp] = useState<string | null>(null);
  // UUID of the entry currently at the top of the viewport (the "you are here" marker)
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);

  const [viewMode, setViewMode] = useTranscriptMode();

  const lensRef = `${projectEncodedName}/${sessionId}`;

  // First and last timestamps in the transcript (for duration-from-start display)
  const transcriptStartTs = useMemo(() => {
    if (!transcript) return null;
    for (const e of transcript.entries) {
      const ts = resolveEntryTimestamp(e);
      if (ts) return ts;
    }
    return null;
  }, [transcript]);

  const transcriptEndTs = useMemo(() => {
    if (!transcript) return null;
    for (let i = transcript.entries.length - 1; i >= 0; i--) {
      const ts = resolveEntryTimestamp(transcript.entries[i]);
      if (ts) return ts;
    }
    return null;
  }, [transcript]);

  const transcriptPath = useMemo(() => {
    const home = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
    return home ? `${home}/.claude/projects/${projectEncodedName}/${sessionId}.jsonl` : null;
  }, [projectEncodedName, sessionId]);

  const [copiedPath, setCopiedPath] = useState(false);
  const handleCopyPath = useCallback(() => {
    if (!transcriptPath) return;
    void navigator.clipboard.writeText(transcriptPath).then(() => {
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    });
  }, [transcriptPath]);

  // ── Data fetch ────────────────────────────────────────────────────────────
  useEffect(() => {
    const home = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
    const computeNode = dataContext.computeNode;
    if (!home || !computeNode?.typeId) {
      setError('Could not resolve compute node or home directory');
      setIsLoading(false);
      return;
    }

    const typeId = computeNode.typeId;
    const path = `${home}/.claude/projects/${projectEncodedName}/${sessionId}.jsonl`;

    const fetchTranscript = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const content = await fsManager.download(typeId, path);
        if (typeof content !== 'string') throw new Error('Transcript content is not a string');

        const parsed = parseTranscript(content);
        setTranscript(parsed);

        // Initialize clock display from the first timestamped entry.
        // The scroll listener won't fire until the user actually scrolls, so
        // without this the top bar would stay blank on first load.
        for (const entry of parsed.entries) {
          const ts = resolveEntryTimestamp(entry);
          if (ts) {
            internalTimestampRef.current = ts;
            setDisplayTimestamp(ts);
            setCurrentEntryId(entry.uuid);
            break;
          }
        }

        const toolNames = parsed.entries
          .filter(isAssistantEntry)
          .flatMap((e) => e.message.content.filter(isToolUseBlock).map((t) => t.name))
          .filter(Boolean);
        const initialFilters: Record<string, boolean> = {};
        Array.from(new Set(toolNames)).forEach((n) => { initialFilters[n] = true; });
        setToolFilters(initialFilters);
        setShowUser(true);
        setShowAssistant(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load transcript');
      } finally {
        setIsLoading(false);
      }
    };

    void fetchTranscript();
  }, [projectEncodedName, sessionId]);

  // ── Resolved entry for URL-param highlight & initial scroll ───────────────
  // No viewMode dependency — purely driven by URL params.
  const resolvedEntryId = useMemo(() => {
    if (!transcript) return undefined;
    if (selectedEntryId) {
      const found = transcript.entries.find((e) => e.uuid === selectedEntryId);
      if (found) return found.uuid;
    }
    if (selectedTimestamp) {
      const targetMs = new Date(selectedTimestamp).getTime();
      if (Number.isNaN(targetMs)) return undefined;
      let best: TranscriptEntry | null = null;
      let bestDiff = Infinity;
      for (const entry of transcript.entries) {
        const ts = resolveEntryTimestamp(entry);
        if (!ts) continue;
        const diff = Math.abs(new Date(ts).getTime() - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
      }
      return best?.uuid;
    }
    return undefined;
  }, [transcript, selectedEntryId, selectedTimestamp]);

  // Trigger initial scroll when URL-param entry resolves.
  // Skip when the URL change itself came from the scroll listener (prevents loop).
  useEffect(() => {
    if (resolvedEntryId) {
      if (urlUpdatedByScrollRef.current) {
        urlUpdatedByScrollRef.current = false;
        return;
      }
      setPendingScrollId(resolvedEntryId);
      // Auto-expand the target entry in both view modes so content is visible on refresh.
      setExpandedEntries((prev) => prev.has(resolvedEntryId) ? prev : new Set([...prev, resolvedEntryId]));
      setChatExpandedEntries((prev) => prev.has(resolvedEntryId) ? prev : new Set([...prev, resolvedEntryId]));
    }
  }, [resolvedEntryId]);

  // ── Scroll-to effect ──────────────────────────────────────────────────────
  // Fires whenever pendingScrollId is set. Marks programmatic scroll ON so the
  // listener ignores these events, then clears itself after animation.
  useEffect(() => {
    if (!pendingScrollId || !transcript) return;

    // In transcript mode, expand the target entry so it's visible
    if (viewMode === 'transcript') {
      setExpandedEntries((prev) => {
        if (prev.has(pendingScrollId)) return prev;
        const next = new Set(prev);
        next.add(pendingScrollId);
        return next;
      });
    }

    // Update display to reflect where we're scrolling to
    const targetEntry = transcript.entries.find((e) => e.uuid === pendingScrollId);
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

    // Use scrollend to detect when smooth scroll animation finishes exactly,
    // with a 1500ms fallback for browsers that don't support it.
    const fallbackTimer = setTimeout(clearProgrammatic, 1500);
    container?.addEventListener('scrollend', clearProgrammatic, { once: true });

    return () => {
      clearTimeout(t1);
      clearTimeout(fallbackTimer);
      container?.removeEventListener('scrollend', clearProgrammatic);
    };
  }, [pendingScrollId, transcript, viewMode]);

  // ── Scroll listener: tracks which entry is at the top of the viewport ─────
  // Uses data-entry-ts attributes set on entry wrapper divs.
  // Only reads refs/DOM — no state updates → no re-render risk.
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
        if (rect.bottom < containerTop) continue; // fully above viewport
        const dist = rect.top - containerTop;
        if (dist >= 0 && dist < bestDist) { bestDist = dist; bestEl = el; }
      }
      if (bestEl) {
        const ts = bestEl.getAttribute('data-entry-ts');
        const uuid = bestEl.getAttribute('data-entry-uuid');
        if (ts) {
          internalTimestampRef.current = ts;
          // Debounce state updates so display refreshes ~150ms after scroll settles
          if (displayTimerRef.current) clearTimeout(displayTimerRef.current);
          displayTimerRef.current = window.setTimeout(() => {
            setDisplayTimestamp(ts);
            if (uuid) {
              setCurrentEntryId(uuid);
              // Reflect scroll position in URL (replace, not push) so refresh restores location
              urlUpdatedByScrollRef.current = true;
              setSearchParams((prev) => { prev.set('transcript_entry_id', uuid); return prev; }, { replace: true });
            }
          }, 150);
        }
      }
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  // Re-attach after mode switch (new container div) or after transcript loads
  // (during loading the containerRef div isn't mounted yet, so first-run is a no-op).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, isLoading]);

  // ── Mode switch: captures current viewport timestamp, finds equivalent entry ─
  const switchMode = (newMode: 'chat' | 'transcript') => {
    if (newMode === viewMode) return;

    // Block the scroll listener immediately — the new container will be at position 0
    // and the scroll effect won't set isProgrammaticScrollRef until after the next render.
    isProgrammaticScrollRef.current = true;

    // Prefer the explicitly-selected entry (currentEntryId) over the scroll-derived
    // internalTimestampRef, which tracks the viewport top and may differ from the selection.
    const anchorEntry = currentEntryId
      ? transcript?.entries.find((e) => e.uuid === currentEntryId) ?? null
      : null;
    const anchorTs = anchorEntry
      ? resolveEntryTimestamp(anchorEntry)
      : internalTimestampRef.current;

    if (anchorTs && transcript) {
      const targetMs = new Date(anchorTs).getTime();
      if (!Number.isNaN(targetMs)) {
        // In chat mode only text-bearing user/assistant entries are visible
        const candidates = newMode === 'chat'
          ? transcript.entries.filter((e) => {
              if (isAssistantEntry(e)) return true;
              if (isUserEntry(e)) {
                const text =
                  typeof e.message.content === 'string'
                    ? e.message.content
                    : e.message.content.filter((c) => c.type === 'text').map((c) => ('text' in c ? c.text : '')).join('');
                return text.trim().length > 0;
              }
              return false;
            })
          : transcript.entries;

        let best: TranscriptEntry | null = null;
        let bestDiff = Infinity;
        for (const entry of candidates) {
          const ts = resolveEntryTimestamp(entry);
          if (!ts) continue;
          const diff = Math.abs(new Date(ts).getTime() - targetMs);
          if (diff < bestDiff) { bestDiff = diff; best = entry; }
        }
        if (best) {
          setPendingScrollId(best.uuid);
          // Keep URL in sync so the new mode's entry is the active one
          setSearchParams((prev) => { prev.set('transcript_entry_id', best!.uuid); return prev; }, { replace: true });
        }
      }
    }

    // Reset so the new view's listener starts fresh
    internalTimestampRef.current = null;
    setViewMode(newMode);
  };

  // ── Filters & search ──────────────────────────────────────────────────────
  const filteredEntries = useMemo(() => {
    if (!transcript) return [];
    const query = searchQuery.trim().toLowerCase();
    return transcript.entries.filter((entry) => {
      if (isUserEntry(entry)) {
        if (!showUser) return false;
        if (!query) return true;
        const content =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.filter((c) => c.type === 'text').map((c) => ('text' in c ? c.text : '')).join('\n');
        return content.toLowerCase().includes(query);
      }
      if (isAssistantEntry(entry)) {
        if (!showAssistant) return false;
        const textContent = entry.message.content.filter(isTextBlock).map((b) => b.text).join('\n');
        if (!query) {
          const toolBlocks = entry.message.content.filter(isToolUseBlock);
          if (toolBlocks.length === 0) return true;
          return toolBlocks.some((tool) => toolFilters[tool.name] !== false);
        }
        const toolBlocks = entry.message.content.filter(isToolUseBlock);
        const toolMatch = toolBlocks.some(
          (tool) =>
            toolFilters[tool.name] !== false &&
            (tool.name.toLowerCase().includes(query) || JSON.stringify(tool.input).toLowerCase().includes(query)),
        );
        return toolMatch || textContent.toLowerCase().includes(query);
      }
      if (!showUser && !showAssistant) return false;
      if (!query) return true;
      return JSON.stringify(entry).toLowerCase().includes(query);
    });
  }, [transcript, showUser, showAssistant, toolFilters, searchQuery]);

  // Chat mode only shows user/assistant entries that have actual text content.
  // User entries that contain only tool_result blocks (no text) are automated
  // tool-response messages — skip them in chat mode.
  const chatEntries = useMemo(
    () =>
      filteredEntries.filter((e) => {
        if (isAssistantEntry(e)) {
          // Skip assistant entries with no meaningful content (e.g. streaming partials
          // that only contain an encrypted/empty thinking block)
          const hasText = e.message.content.some((b) => isTextBlock(b) && b.text);
          const hasTools = e.message.content.some(isToolUseBlock);
          const hasVisibleThinking = e.message.content.some((b) => isThinkingBlock(b) && b.thinking);
          return hasText || hasTools || hasVisibleThinking;
        }
        if (isUserEntry(e)) {
          const text =
            typeof e.message.content === 'string'
              ? e.message.content
              : e.message.content
                  .filter((c) => c.type === 'text')
                  .map((c) => ('text' in c ? c.text : ''))
                  .join('');
          return text.trim().length > 0;
        }
        return false;
      }),
    [filteredEntries],
  );

  const toolCounts = useMemo(() => {
    if (!transcript) return {};
    const counts: Record<string, number> = {};
    transcript.entries.forEach((entry) => {
      if (!isAssistantEntry(entry)) return;
      entry.message.content.filter(isToolUseBlock).forEach((tool) => {
        if (!tool.name) return;
        counts[tool.name] = (counts[tool.name] || 0) + 1;
      });
    });
    return counts;
  }, [transcript]);

  const toggleToolFilter = (toolName: string) => {
    setToolFilters((prev) => ({ ...prev, [toolName]: !prev[toolName] }));
  };

  const clearAllFilters = () => {
    if (!transcript) return;
    const toolNames = transcript.entries
      .filter(isAssistantEntry)
      .flatMap((entry) => entry.message.content.filter(isToolUseBlock).map((tool) => tool.name))
      .filter(Boolean);
    const nextFilters: Record<string, boolean> = {};
    Array.from(new Set(toolNames)).forEach((n) => { nextFilters[n] = true; });
    setToolFilters(nextFilters);
    setShowUser(true);
    setShowAssistant(true);
    setSearchQuery('');
  };

  const disableAllFilters = () => {
    if (!transcript) return;
    const toolNames = transcript.entries
      .filter(isAssistantEntry)
      .flatMap((entry) => entry.message.content.filter(isToolUseBlock).map((tool) => tool.name))
      .filter(Boolean);
    const nextFilters: Record<string, boolean> = {};
    Array.from(new Set(toolNames)).forEach((n) => { nextFilters[n] = false; });
    setToolFilters(nextFilters);
    setShowUser(false);
    setShowAssistant(false);
  };

  const getEntryDetails = (entry: TranscriptEntry) => {
    const base = {
      entry_id: entry.uuid,
      entry_type: entry.type,
      timestamp: resolveEntryTimestamp(entry),
      session_id: transcript?.sessionId || null,
      transcript_ref: lensRef,
      is_sidechain: 'isSidechain' in entry ? (entry.isSidechain ?? false) : false,
      parent_uuid: 'parentUuid' in entry ? (entry.parentUuid ?? null) : null,
      parent_tool_use_id: 'parentToolUseID' in entry ? (entry.parentToolUseID ?? null) : null,
    } as Record<string, unknown>;

    if (isUserEntry(entry)) {
      const content =
        typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.filter((c) => c.type === 'text').map((c) => ('text' in c ? c.text : '')).join('\n');
      return { ...base, role: 'user', content, tool_result: entry.toolUseResult ?? null };
    }
    if (isAssistantEntry(entry)) {
      return {
        ...base,
        role: 'assistant',
        text: entry.message.content.filter(isTextBlock).map((b) => b.text).join('\n'),
        tools: entry.message.content.filter(isToolUseBlock).map((t) => ({ id: t.id, name: t.name, input: t.input })),
        thinking: entry.message.content.filter(isThinkingBlock).map((t) => t.thinking),
        usage: entry.message.usage ?? null,
      };
    }
    return { ...base, role: 'system', raw: entry };
  };

  const handleOpenInTerminal = useCallback(async () => {
    const p = await navigation.openWorkerSession(sessionId);
    if (!p) {
      toast({ title: 'Session not found', description: `Session ${sessionId} is not in Claude or Codex history.`, variant: 'destructive' });
    }
  }, [navigation, sessionId]);

  const handleOpenTaskLink = useMemo(() => {
    if (!transcript?.sessionId) return undefined;
    return (activeForm?: string) => {
      const options: Record<string, string> = { project: projectEncodedName };
      if (activeForm) options.active_form = activeForm;
      navigation.openLens('claude', 'tasks', transcript.sessionId!, options);
    };
  }, [transcript?.sessionId, navigation, projectEncodedName]);

  const handleOpenTasksOverview = useMemo(() => {
    if (!handleOpenTaskLink) return undefined;
    return () => handleOpenTaskLink();
  }, [handleOpenTaskLink]);

  const toggleEntry = (uuid: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
    navigation.openLens('claude', 'transcript', lensRef, { transcript_entry_id: uuid });
  };

  const toggleChatEntry = (uuid: string) => {
    setChatExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const expandAllChat = () => {
    if (!transcript) return;
    setChatExpandedEntries(new Set(
      transcript.entries.filter((e) => isUserEntry(e) || isAssistantEntry(e)).map((e) => e.uuid),
    ));
  };

  const collapseAllChat = () => setChatExpandedEntries(new Set());

  // ── Loading / error / empty states ────────────────────────────────────────
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
          <p className="mt-1 text-sm">{error}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{lensRef}</p>
        </div>
      </div>
    );
  }
  if (!transcript) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        <p>No transcript data</p>
      </div>
    );
  }

  const openInfo = (entry: TranscriptEntry) => {
    if (infoHoverTimerRef.current) { window.clearTimeout(infoHoverTimerRef.current); infoHoverTimerRef.current = null; }
    setInfoEntry(entry);
    setInfoOpen(true);
  };
  const scheduleInfoOpen = (entry: TranscriptEntry) => {
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

  // ── Info dialog ───────────────────────────────────────────────────────────
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
                onClick={() => { void navigator.clipboard.writeText(JSON.stringify(getEntryDetails(infoEntry), null, 2)); }}
              >
                Copy entry
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify({
                    transcript_ref: lensRef,
                    session_id: transcript?.sessionId || null,
                    entry: getEntryDetails(infoEntry),
                    filters: { show_user: showUser, show_assistant: showAssistant, tool_filters: toolFilters, search_query: searchQuery },
                  }, null, 2));
                }}
              >
                Copy all
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-all rounded border border-border bg-muted/30 p-3 font-mono text-[11px]">
              {JSON.stringify(getEntryDetails(infoEntry), null, 2)}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  // ── Shared outer layout ───────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col bg-background">

      {/* Single top bar — always in the same place, never moves */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <ViewModeToggle mode={viewMode} onChange={switchMode} />

        <button
          type="button"
          onClick={handleOpenInTerminal}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Open agentic process in terminal"
        >
          <Terminal className="h-3 w-3" />
        </button>

        {/* Scroll-position clock — updates as you scroll */}
        <div className="flex flex-1 items-center justify-center gap-0 text-[11px] tabular-nums">
          {/* Start anchor */}
          {transcriptStartTs && (
            <span className="text-muted-foreground/50 text-[10px]" title="Session start">
              {new Date(transcriptStartTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}

          {transcriptStartTs && <span className="mx-2 text-border">·····</span>}

          {/* Current position (lives and updates with scroll) */}
          {displayTimestamp ? (
            <span className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {new Date(displayTimestamp).toLocaleTimeString()}
              </span>
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

          {/* End anchor */}
          {transcriptEndTs && (
            <span className="text-muted-foreground/50 text-[10px]" title="Session end">
              {new Date(transcriptEndTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

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

      {/* Mode-specific content */}
      {viewMode === 'chat' ? (
        <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          {chatEntries.map((entry) => {
            const entryTs = resolveEntryTimestamp(entry);
            const isSelected = entry.uuid === resolvedEntryId;
            const isCurrent = entry.uuid === currentEntryId && !isSelected;
            return (
              <div
                key={entry.uuid}
                ref={entry.uuid === pendingScrollId ? scrollTargetRef : undefined}
                data-entry-ts={entryTs ?? undefined}
                data-entry-uuid={entry.uuid}
                className={
                  isSelected ? 'bg-primary/5 ring-1 ring-inset ring-primary/30'
                  : isCurrent ? 'border-l-[3px] border-primary/40 bg-muted/20'
                  : undefined
                }
                onClick={() => {
                  if (!entryTs) return;
                  internalTimestampRef.current = entryTs;
                  setDisplayTimestamp(entryTs);
                  setCurrentEntryId(entry.uuid);
                  urlUpdatedByScrollRef.current = true;
                  setSearchParams((prev) => { prev.set('transcript_entry_id', entry.uuid); return prev; }, { replace: true });
                }}
              >
                <ChatEntryItem
                  entry={entry}
                  toolFilters={toolFilters}
                  isExpanded={chatExpandedEntries.has(entry.uuid)}
                  onToggle={() => toggleChatEntry(entry.uuid)}
                />
              </div>
            );
          })}
        </div>
      ) : (
        /* Transcript mode */
        <div className="flex min-h-0 flex-1 flex-col">
          <TranscriptStats
            transcript={transcript}
            showUser={showUser}
            showAssistant={showAssistant}
            toolFilters={toolFilters}
            toolCounts={toolCounts}
            onToggleUser={() => setShowUser((prev) => !prev)}
            onToggleAssistant={() => setShowAssistant((prev) => !prev)}
            onToggleTool={toggleToolFilter}
            onClearFilters={clearAllFilters}
            onDisableAll={disableAllFilters}
            onOpenTasks={handleOpenTasksOverview}
          />

          {transcriptPath && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1">
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              <span className="truncate font-mono text-[10px] text-muted-foreground" title={transcriptPath}>
                {transcriptPath}
              </span>
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={handleCopyPath}
                title="Copy transcript path"
              >
                {copiedPath ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          )}

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
            {filteredEntries.map((entry) => {
              const entryTs = resolveEntryTimestamp(entry);
              const isSelected = entry.uuid === resolvedEntryId;
              const isCurrent = entry.uuid === currentEntryId && !isSelected;
              return (
                <div
                  key={entry.uuid}
                  ref={entry.uuid === pendingScrollId ? scrollTargetRef : undefined}
                  data-entry-ts={entryTs ?? undefined}
                  data-entry-uuid={entry.uuid}
                  className={
                    isSelected ? 'rounded bg-primary/10 ring-1 ring-primary'
                    : isCurrent ? 'border-l-[3px] border-primary/40 bg-muted/20'
                    : undefined
                  }
                  onClick={() => {
                    if (!entryTs) return;
                    internalTimestampRef.current = entryTs;
                    setDisplayTimestamp(entryTs);
                    setCurrentEntryId(entry.uuid);
                    urlUpdatedByScrollRef.current = true;
                    setSearchParams((prev) => { prev.set('transcript_entry_id', entry.uuid); return prev; }, { replace: true });
                  }}
                >
                  <TranscriptEntryItem
                    entry={entry}
                    isExpanded={expandedEntries.has(entry.uuid)}
                    onToggle={() => toggleEntry(entry.uuid)}
                    toolFilters={toolFilters}
                    onInfo={() => openInfo(entry)}
                    onInfoHover={() => scheduleInfoOpen(entry)}
                    onInfoHoverEnd={cancelInfoOpen}
                    onOpenTaskLink={handleOpenTaskLink}
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
