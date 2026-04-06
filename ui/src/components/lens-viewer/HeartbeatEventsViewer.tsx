import { LAYER_COLORS } from '@src/hooks/sniffer-layers';
import { useEventFilterMask } from '@src/hooks/use-event-filter-mask';
import { type EventLayer, type SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { useSnifferContext } from '@src/contexts/SnifferContext';
import { useSnifferPipeline, parsePipelineFilters, SnifferScope, type PipelineFilters } from '@src/hooks/use-sniffer-pipeline';
import { EventOneLiner } from '@src/components/hooks/event-summaries';
import { getEventColor, getEventIcon, navigateToTranscript } from '@src/components/hooks/event-utils';
import { FilterMaskIndicator } from '@src/components/hooks/FilterMaskIndicator';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@sdk';
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  FileText,
  List,
  Radio,
  Trash2,
  ScrollText,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Filter persistence (shared keys with EventSnifferChip)
// ---------------------------------------------------------------------------

const FILTERS_STORAGE_KEY = 'flowpad-sniffer-filters';

function loadFilters(): PipelineFilters {
  return parsePipelineFilters(localStorage.getItem(FILTERS_STORAGE_KEY));
}

function saveFilters(filters: PipelineFilters): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Layer filter persistence
// ---------------------------------------------------------------------------

const LAYERS_STORAGE_KEY = 'flowpad-sniffer-layers';

const ALL_LAYERS: EventLayer[] = ['debug', 'info', 'raw_notifications', 'resource'];

const LAYER_LABELS: Record<EventLayer, string> = {
  debug: 'debug',
  info: 'info',
  raw_notifications: 'notifications',
  resource: 'resource',
};

function loadLayers(): EventLayer[] | null {
  try {
    const stored = localStorage.getItem(LAYERS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.filter((l: string) => ALL_LAYERS.includes(l as EventLayer)) as EventLayer[];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function saveLayers(layers: EventLayer[] | null): void {
  try {
    if (layers !== null) {
      localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(layers));
    } else {
      localStorage.removeItem(LAYERS_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  viewMode?: 'live' | 'json';
  selectedEventId?: string;
  selectedTimestamp?: string;
}

const FILTER_LABEL = 'text-[10px] font-semibold text-foreground';

// ---------------------------------------------------------------------------
// HeartbeatEventsViewer
// ---------------------------------------------------------------------------

export function HeartbeatEventsViewer({ viewMode = 'live', selectedEventId, selectedTimestamp }: Props) {
  const { events, clear, maxEvents, setMaxEvents } = useSnifferContext();
  const { navigation } = useDockNavigation();
  const { mask, setFilter, removeFilter, clearAll: clearMask } = useEventFilterMask();
  const isJsonMode = viewMode === 'json';

  const [filters, setFilters] = useState<PipelineFilters>(() => {
    const base = loadFilters();
    const layers = loadLayers();
    return layers ? { ...base, layers } : base;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const selectedRowRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  // Scroll-lock refs (used after displayEvents is computed)
  const prevEventCountRef = useRef(0);
  const scrollSnapshotRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);

  const handleFilterChange = useCallback((update: Partial<PipelineFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...update };
      saveFilters(next);
      return next;
    });
  }, []);

  const handleLayerToggle = useCallback((layer: EventLayer) => {
    setFilters((prev) => {
      const current = prev.layers ?? [...ALL_LAYERS];
      const has = current.includes(layer);
      const next: EventLayer[] = has ? current.filter((l) => l !== layer) : [...current, layer];
      // If all selected, clear the layers filter (use level fallback)
      const allSelected = ALL_LAYERS.every((l) => next.includes(l));
      const layers = allSelected ? undefined : next;
      saveLayers(layers ?? null);
      return { ...prev, layers };
    });
  }, []);

  const activeLayers = filters.layers ?? ALL_LAYERS;

  const pipelineFilters = useMemo<PipelineFilters>(
    () => ({ ...filters, mask: Object.keys(mask).length > 0 ? mask : undefined }),
    [filters, mask],
  );
  const { filteredEvents } = useSnifferPipeline(events, pipelineFilters);

  // Newest-first display order
  const displayEvents = useMemo(() => [...filteredEvents].reverse(), [filteredEvents]);

  // Scroll-lock: snapshot scroll state before React commits DOM changes
  const userIsInteracting = selectedId !== null || expandedId !== null;
  if (userIsInteracting && scrollContainerRef.current) {
    const el = scrollContainerRef.current;
    const newCount = displayEvents.length;
    if (newCount > prevEventCountRef.current && prevEventCountRef.current > 0) {
      scrollSnapshotRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    } else {
      scrollSnapshotRef.current = null;
    }
  } else {
    scrollSnapshotRef.current = null;
  }
  prevEventCountRef.current = displayEvents.length;

  // After DOM update, adjust scrollTop to compensate for newly prepended items
  useLayoutEffect(() => {
    const snap = scrollSnapshotRef.current;
    if (!snap || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current;
    const heightDelta = el.scrollHeight - snap.scrollHeight;
    if (heightDelta > 0) {
      el.scrollTop = snap.scrollTop + heightDelta;
    }
    scrollSnapshotRef.current = null;
  }, [displayEvents]);

  // JSON trace blob (newest-first, parsed raw_line back to objects)
  const jsonTrace = useMemo(() => {
    const entries = displayEvents.map((e) => {
      try {
        return JSON.parse(e.raw_line);
      } catch {
        return e.raw_line;
      }
    });
    return JSON.stringify({ 'flow-events': entries }, null, 2);
  }, [displayEvents]);

  // Derive transcript path from the first event that has one
  const transcriptPath = useMemo(() => {
    for (const e of displayEvents) {
      if (e.transcript_path) return e.transcript_path;
    }
    return null;
  }, [displayEvents]);

  const [copied, setCopied] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const handleCopyJson = useCallback(() => {
    void navigator.clipboard.writeText(jsonTrace).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [jsonTrace]);

  const handleCopyPath = useCallback(() => {
    if (!transcriptPath) return;
    void navigator.clipboard.writeText(transcriptPath).then(() => {
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    });
  }, [transcriptPath]);

  const handleCopyEvent = useCallback((e: React.MouseEvent, event: SnifferEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(event.raw_line).then(() => {
      setCopiedEventId(event.id);
      setTimeout(() => setCopiedEventId(null), 1500);
    });
  }, []);

  // Resolve initial selection target
  useEffect(() => {
    if (initialScrollDone.current) return;
    if (displayEvents.length === 0) return;

    let targetId: string | null = null;

    if (selectedEventId) {
      const match = displayEvents.find((e) => e.id === selectedEventId);
      if (match) targetId = match.id;
    }

    if (!targetId && selectedTimestamp) {
      const targetMs = new Date(selectedTimestamp).getTime();
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
      let closest: SnifferEvent | null = null;
      let closestDiff = Infinity;
      for (const e of displayEvents) {
        const diff = Math.abs(new Date(e.timestamp).getTime() - targetMs);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest = e;
        }
      }
      if (closest) targetId = closest.id;
    }

    if (!targetId) {
      targetId = displayEvents[0].id; // latest event
    }

    setSelectedId(targetId);
    initialScrollDone.current = true;
  }, [displayEvents, selectedEventId, selectedTimestamp]);

  // Scroll selected row into view
  useEffect(() => {
    if (selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedId]);

  const handleRowClick = useCallback(
    (event: SnifferEvent) => {
      if (selectedId === event.id) {
        // Toggle expand on re-click
        setExpandedId((prev) => (prev === event.id ? null : event.id));
      } else {
        setSelectedId(event.id);
        setExpandedId(null);
      }
    },
    [selectedId],
  );

  const handleTranscriptClick = useCallback(
    (e: React.MouseEvent, event: SnifferEvent) => {
      e.stopPropagation();
      navigateToTranscript(event, navigation);
    },
    [navigation],
  );

  const handleHookClick = useCallback(
    (e: React.MouseEvent, event: SnifferEvent) => {
      e.stopPropagation();
      navigation.openDock(
        new DockPointer(ViewType.HOOKS, undefined, {
          hookId: event.hook_entry_id || '',
          eventType: event.event_type || '',
        }),
      );
    },
    [navigation],
  );

  const handleTriggerLogClick = useCallback(
    (e: React.MouseEvent, event: SnifferEvent) => {
      e.stopPropagation();
      if (event.triggerLogDockPointer) {
        navigation.openLens('trigger', 'log', event.triggerLogDockPointer.ref);
      }
    },
    [navigation],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Radio className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Events</span>
        <Badge variant="secondary" className="text-[10px]">
          {filteredEvents.length}
        </Badge>

        {/* Max events slider */}
        <div className="flex items-center gap-1.5">
          <span className={FILTER_LABEL}>Limit</span>
          <input
            type="range"
            min={10}
            max={1000}
            step={10}
            value={maxEvents}
            onChange={(e) => setMaxEvents(Number(e.target.value))}
            className="h-1 w-16 cursor-pointer accent-primary"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground">{maxEvents}</span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <FilterMaskIndicator mask={mask} onRemove={removeFilter} onClearAll={clearMask} />

          {/* Scope filter */}
          <div className="flex items-center gap-1.5">
            <span className={FILTER_LABEL}>Scope</span>
            <div className="flex items-center rounded-md border bg-muted/50">
              {([SnifferScope.All, SnifferScope.Project]).map((value, i) => (
                <button
                  key={value}
                  className={cn(
                    'px-2 py-0.5 text-[10px] font-medium transition-colors',
                    filters.scope === value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                    i === 0 && 'rounded-l-[5px]',
                    i === 1 && 'rounded-r-[5px]',
                  )}
                  onClick={() => handleFilterChange({ scope: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="h-4 w-px bg-muted-foreground/30" />

          {/* Layer filter */}
          <div className="flex items-center gap-1.5">
            <span className={FILTER_LABEL}>Layers</span>
            <div className="flex items-center gap-1">
              {ALL_LAYERS.map((layer) => {
                const isActive = activeLayers.includes(layer);
                return (
                  <button
                    key={layer}
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                      isActive
                        ? `border-current bg-muted/80 ${LAYER_COLORS[layer]}`
                        : 'border-transparent text-muted-foreground/70 hover:text-foreground',
                    )}
                    onClick={() => handleLayerToggle(layer)}
                  >
                    {LAYER_LABELS[layer]}
                  </button>
                );
              })}
              <span className="mx-0.5 text-border">|</span>
              <button
                className="px-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  saveLayers(null);
                  setFilters((prev) => ({ ...prev, layers: undefined }));
                }}
              >
                all
              </button>
              <button
                className="px-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  saveLayers([]);
                  setFilters((prev) => ({ ...prev, layers: [] }));
                }}
              >
                none
              </button>
            </div>
          </div>

          <div className="h-4 w-px bg-muted-foreground/30" />

          {/* View toggle */}
          <div className="flex items-center rounded-md border bg-muted/50">
            <button
              className={cn(
                'flex items-center gap-1 rounded-l-[5px] px-2 py-0.5 text-[10px] font-medium transition-colors',
                !isJsonMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => navigation.openLens('heartbeat', 'events', 'live')}
            >
              <List className="h-3 w-3" />
              List
            </button>
            <button
              className={cn(
                'flex items-center gap-1 rounded-r-[5px] px-2 py-0.5 text-[10px] font-medium transition-colors',
                isJsonMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => navigation.openLens('heartbeat', 'events', 'json')}
            >
              <Braces className="h-3 w-3" />
              JSON
            </button>
          </div>

          <div className="h-4 w-px bg-muted-foreground/30" />

          {/* Clear */}
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={() => clear()}>
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
        </div>
      </div>

      {/* Transcript path */}
      {transcriptPath && (
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-1">
          <FileText className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground" title={transcriptPath}>
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

      {/* Body */}
      {isJsonMode ? (
        <div className="relative flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-end border-b border-border bg-background/80 px-4 py-1.5 backdrop-blur-sm">
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={handleCopyJson}>
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre className="whitespace-pre-wrap break-all p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {jsonTrace}
          </pre>
        </div>
      ) : (
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          {displayEvents.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No events captured
            </div>
          ) : (
            <div className="divide-y divide-border">
              {displayEvents.map((event) => {
                const Icon = getEventIcon(event.event_type, event);
                const isSelected = selectedId === event.id;
                const isExpanded = expandedId === event.id;

                return (
                  <div
                    key={event.id}
                    ref={isSelected ? selectedRowRef : undefined}
                    className={cn('cursor-pointer transition-colors', isSelected ? 'bg-accent' : 'hover:bg-muted/50')}
                    onClick={() => handleRowClick(event)}
                  >
                    {/* Main row */}
                    <div className="flex items-center gap-2 px-4 py-2">
                      <span className="w-6 shrink-0 text-right font-mono text-[10px] text-green-700 dark:text-green-500">
                        {event.idx}
                      </span>
                      <button
                        className="shrink-0 text-muted-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedId((prev) => (prev === event.id ? null : event.id));
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <Icon className={cn('h-4 w-4 shrink-0', getEventColor(event))} />
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {event.event_type}
                      </Badge>
                      <EventOneLiner event={event} className="min-w-0 flex-1 truncate text-xs text-muted-foreground" />
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.session_id
                              ? mask.session_id === event.session_id
                                ? 'bg-primary/20 text-primary hover:bg-primary/30'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.session_id}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (event.session_id) setFilter('session_id', event.session_id);
                          }}
                          title="Filter by session"
                        >
                          <Crosshair className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          onClick={(e) => handleCopyEvent(e, event)}
                          title="Copy event JSON"
                        >
                          {copiedEventId === event.id ? (
                            <Check className="h-3.5 w-3.5 text-green-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.transcriptDockPointer
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.transcriptDockPointer}
                          onClick={(e) => handleTranscriptClick(e, event)}
                          title="View transcript"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.hook_entry_id
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.hook_entry_id}
                          onClick={(e) => handleHookClick(e, event)}
                          title="View hook"
                        >
                          <Webhook className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.triggerLogDockPointer
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.triggerLogDockPointer}
                          onClick={(e) => handleTriggerLogClick(e, event)}
                          title="View trigger log"
                        >
                          <ScrollText className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Expanded JSON detail */}
                    {isExpanded && (
                      <div
                        className="border-t border-border bg-muted/30 px-4 py-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <pre className="select-text whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted-foreground">
                          {event.raw_line}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
