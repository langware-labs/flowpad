import { EventTooltipContent, getEventColor, getEventIcon, getOneLiner, getTranscriptLensPointer } from '@src/components/hooks/event-utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { TraceGutterEntry } from './use-trace-gutter';
import React, { useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

function formatTimeAgo(timestamp: string): string {
  const then = new Date(timestamp).getTime();
  if (isNaN(then)) return '';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

interface TraceGutterProps {
  entries: TraceGutterEntry[];
  totalTraceEvents: number;
  historicalCount: number;
  liveCount: number;
  viewportY: number;
  rows: number;
  cellHeight: number;
  expanded: boolean;
  onOpen: () => void;
  onClose: () => void;
  hideCounter?: boolean;
}

interface RowGroup {
  row: number;
  entries: TraceGutterEntry[];
}

const GUTTER_WIDTH = 48; // constant — never changes so terminal never refits
const PANEL_WIDTH = 220;

/**
 * TraceGutter — 20px dot column alongside the terminal (constant width,
 * no layout shift). Click a dot to open a floating overlay panel with the
 * full event trace. The overlay is absolutely positioned and does NOT affect
 * the flex layout, so xterm never refits.
 */
export const TraceGutter = React.memo(function TraceGutter({
  entries,
  viewportY,
  rows,
  cellHeight,
  totalTraceEvents,
  historicalCount,
  liveCount,
  expanded,
  onOpen,
  onClose,
  hideCounter = false,
}: TraceGutterProps) {

  const panelRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  // null = show all entries; set = show only this group's entries
  const [selectedEntries, setSelectedEntries] = useState<TraceGutterEntry[] | null>(null);

  // Reset selection when panel closes
  useEffect(() => {
    if (!expanded) setSelectedEntries(null);
  }, [expanded]);

  // Close on click outside both the panel and the gutter column
  useEffect(() => {
    if (!expanded) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (gutterRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [expanded, onClose]);

  // Always render the 20px container — returning null would collapse it,
  // changing terminal width and triggering ResizeObserver → fit → flicker.
  if (cellHeight <= 0) return null;

  // Filter to visible range and group by row
  const rowMap = new Map<number, TraceGutterEntry[]>();
  for (const entry of entries) {
    if (entry.absRow == null || entry.absRow < viewportY || entry.absRow >= viewportY + rows) continue;
    const row = entry.absRow - viewportY;
    let group = rowMap.get(row);
    if (!group) {
      group = [];
      rowMap.set(row, group);
    }
    group.push(entry);
  }

  const rowGroups: RowGroup[] = Array.from(rowMap.entries())
    .map(([row, groupEntries]) => ({ row, entries: groupEntries }))
    .sort((a, b) => a.row - b.row);

  return (
    <TooltipProvider delayDuration={200}>
      {/* Outer wrapper: constant GUTTER_WIDTH in the flex row — never changes */}
      <div
        ref={gutterRef}
        data-testid="trace-gutter"
        className="relative shrink-0"
        style={{ width: GUTTER_WIDTH, height: rows * cellHeight }}
      >
        {/* Dot column */}
        <div className="absolute inset-0">
          {/* Total event count badge — always visible at the top */}
          {!hideCounter && <EventCountBadge total={totalTraceEvents} historicalCount={historicalCount} liveCount={liveCount} onOpen={onOpen} />}
          {rowGroups.map((group) => (
            <GutterDot
              key={group.row}
              group={group}
              cellHeight={cellHeight}
              expanded={expanded}
              onOpen={() => { setSelectedEntries(group.entries); onOpen(); }}
            />
          ))}
        </div>

        {/* Floating overlay panel — absolutely positioned, does NOT affect layout */}
        {expanded && entries.length > 0 && (
          <div
            ref={panelRef}
            className="absolute top-0 z-50 flex flex-col rounded-r border border-border bg-popover shadow-lg [background-color:hsl(var(--popover)/1)]"
            style={{
              left: GUTTER_WIDTH,
              width: PANEL_WIDTH,
              maxHeight: rows * cellHeight,
              pointerEvents: 'auto',
            }}
          >
            {/* Panel header with X button */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1">
              <span className="text-xs font-medium text-muted-foreground">
                {selectedEntries ? `${selectedEntries.length} event${selectedEntries.length === 1 ? '' : 's'}` : <Trans>Trace events</Trans>}
              </span>
              <button
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={onClose}
                aria-label={t`Close`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="overflow-y-auto">
              {(selectedEntries ?? entries).map((entry) => (
                <ExpandedEventLine key={entry.event.id} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
});

function EventCountBadge({ total, historicalCount, liveCount, onOpen }: {
  total: number;
  historicalCount: number;
  liveCount: number;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "absolute left-1/2 top-0 flex -translate-x-1/2 items-center justify-center",
            total > 0 && "cursor-pointer hover:bg-accent rounded",
          )}
          style={{ width: GUTTER_WIDTH, height: 18 }}
          onClick={total > 0 ? onOpen : undefined}
        >
          <span
            className="rounded px-0.5 font-mono font-semibold leading-none text-muted-foreground"
            style={{ fontSize: 10 }}
          >
            {historicalCount > 0 ? `${historicalCount} + ${liveCount}` : `${total}`}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={4} className="text-xs">
        {total === 0
          ? <Trans>No trace events captured yet</Trans>
          : `${total} trace event${total === 1 ? '' : 's'} captured`}
      </TooltipContent>
    </Tooltip>
  );
}


function GutterDot({
  group,
  cellHeight,
  expanded,
  onOpen,
}: {
  group: RowGroup;
  cellHeight: number;
  expanded: boolean;
  onOpen: () => void;
}) {
  const primaryEntry = group.entries[group.entries.length - 1];
  const Icon = getEventIcon(primaryEntry.event.event_type, primaryEntry.event);
  const colorClass = getEventColor(primaryEntry.event);
  const count = group.entries.length;

  const dot = (
    <div
      className="absolute flex cursor-pointer items-center justify-center rounded hover:bg-accent"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      style={{
        top: group.row * cellHeight + (cellHeight - 14) / 2,
        left: 0,
        width: GUTTER_WIDTH,
        height: 14,
      }}
    >
      {count > 1 ? (
        <span
          className="flex items-center justify-center rounded-full border border-muted-foreground/40 font-mono font-semibold text-muted-foreground"
          style={{ fontSize: 9, lineHeight: '12px', minWidth: 16, height: 12, paddingInline: 3 }}
        >
          {count}
        </span>
      ) : (
        <Icon className={cn('h-3.5 w-3.5 shrink-0', colorClass)} />
      )}
    </div>
  );

  if (expanded) return dot;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{dot}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-sm bg-popover p-0 text-popover-foreground" sideOffset={4}>
        {count === 1 ? (
          <div className="p-2">
            <EventTooltipContent event={primaryEntry.event} />
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {group.entries.map((entry, i) => {
              const Icon = getEventIcon(entry.event.event_type, entry.event);
              const oneLiner = getOneLiner(entry.event);
              return (
                <div
                  key={entry.event.id}
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 text-xs',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <Icon className={cn('h-3 w-3 shrink-0', getEventColor(entry.event))} />
                  <span className="font-medium text-popover-foreground">{entry.event.event_type}</span>
                  {oneLiner && (
                    <span className="truncate text-popover-foreground/60">{oneLiner}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function ExpandedEventLine({
  entry,
}: {
  entry: TraceGutterEntry;
}) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const Icon = getEventIcon(entry.event.event_type, entry.event);
  const colorClass = getEventColor(entry.event);
  const oneLiner = getOneLiner(entry.event);
  const timeAgo = formatTimeAgo(entry.event.timestamp);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shortType =
    entry.event.event_type.length > 16
      ? entry.event.event_type.slice(0, 15) + '\u2026'
      : entry.event.event_type;

  const lensPointer = getTranscriptLensPointer(entry.event);

  const handleOpenLens = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!lensPointer) return;
    navigation.openLens('claude', 'transcript', lensPointer.ref, lensPointer.options);
  };

  const handleOpenChange = (open: boolean) => {
    if (open) {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      setDetailsOpen(true);
    } else {
      closeTimer.current = setTimeout(() => setDetailsOpen(false), 1000);
    }
  };

  return (
    <Tooltip open={detailsOpen} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>
        <div className="group flex cursor-default items-start gap-1 overflow-hidden px-2 py-0.5 hover:bg-accent">
          {/* Text block */}
          <div className="min-w-0 flex-1">
            {/* Main line: icon + type + one-liner */}
            <div className="flex items-center gap-1 overflow-hidden">
              <Icon className={cn('h-3 w-3 shrink-0', colorClass)} />
              <span className="shrink-0 font-medium text-foreground" style={{ fontSize: 11 }}>
                {shortType}
              </span>
              {oneLiner && (
                <span className="truncate text-foreground/60" style={{ fontSize: 11 }}>
                  {oneLiner}
                </span>
              )}
            </div>
            {/* Subline: time ago */}
            {timeAgo && (
              <span className="pl-4 text-muted-foreground" style={{ fontSize: 10 }}>
                {timeAgo}
              </span>
            )}
          </div>
          {/* Transcript link — matches EventListPanel pattern */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  'mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-colors group-hover:opacity-100',
                  lensPointer
                    ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    : 'cursor-default text-muted-foreground/30',
                )}
                disabled={!lensPointer}
                onClick={handleOpenLens}
              >
                <FileText className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><Trans>View transcript</Trans></TooltipContent>
          </Tooltip>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-sm bg-popover p-0 text-popover-foreground" sideOffset={4}>
        <div className="p-2">
          <EventTooltipContent event={entry.event} />
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
