import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Hand, ListPlus, Maximize2, MessageSquare, Puzzle, SquareTerminal, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Slider } from '@src/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import type { AgentTraceDoc, TraceEvent, TraceLane, TraceMarker } from './trace-types';
import { bucketSegments, tsMs } from './trace-types';

const LANE_ROW_H = 14; // px per lane row (compact Execution strip)
const OUTLINE_ROW_H = 24; // taller rows for the readable Call-stack timeline
const MAX_VISIBLE_LANES_PX = 168; // ~12 rows before the lane list scrolls
// Outline-only: width of the fixed left name column. Lane labels live entirely
// inside [0, GUTTER]; the time track maps into [GUTTER, width] so bars never sit
// behind the names (kills the old label/trace overlap).
const GUTTER = 200;
const MIN_DRAG_PX = 8; // ignore accidental click-drags below this
const CHIP_MIN_PX = 110; // event spacing above which a marker becomes a labelled chip

/** Per-kind icon for the high-zoom event chips. */
const EVENT_ICON: Record<string, LucideIcon> = {
  user_prompt: MessageSquare,
  interrupt: Hand,
  skill_fail: AlertTriangle,
  skill_load: Puzzle,
  task_create: ListPlus,
  task_update: Check,
  error: AlertTriangle,
};

// Outline-only event kinds surfaced on the timeline.
const OUTLINE_EVENT_KINDS = new Set([
  'user_prompt', 'interrupt', 'skill_load', 'skill_fail', 'task_create', 'task_update', 'error',
]);

/** Color for an outline lane's span bar (skills/plan/subagent). */
function outlineSegmentColor(laneKind: string): string {
  if (laneKind === 'skill') return 'bg-primary/60';
  if (laneKind === 'root') return 'bg-amber-500/50'; // plan-mode spans
  return 'bg-sky-500/45'; // subagent span
}

/** Color for an event marker by kind (task completion bumps the shade). */
function eventColor(kind: string, severity: string): string {
  switch (kind) {
    case 'user_prompt':
      return 'bg-blue-500';
    case 'interrupt':
    case 'skill_fail':
      return 'bg-red-500';
    case 'error':
      return 'bg-red-600';
    case 'task_create':
      return 'bg-emerald-500';
    case 'task_update':
      return severity === 'notable' ? 'bg-emerald-700' : 'bg-amber-500';
    default:
      return 'bg-sky-500';
  }
}

/** Legend entries shown above the Call-stack timeline so the markers read. */
export const OUTLINE_LEGEND: { color: string; label: string }[] = [
  { color: 'bg-blue-500', label: 'prompt' },
  { color: 'bg-red-500', label: 'interrupt' },
  { color: 'bg-emerald-500', label: 'task' },
  { color: 'bg-amber-500/70', label: 'plan' },
  // Advanced-only — CallStackView filters this out outside advanced mode, where
  // the errors lane is hidden.
  { color: 'bg-red-600', label: 'error' },
];

function severityBar(severity: string): string {
  return severity === 'attention'
    ? 'bg-red-500/70'
    : severity === 'notable'
      ? 'bg-amber-500/70'
      : 'bg-primary/35';
}

function markerColor(m: TraceMarker): string {
  if (m.kind === 'divergence') return 'bg-purple-500';
  return m.severity === 'attention' ? 'bg-red-500' : 'bg-amber-500';
}

interface TraceTimelineProps {
  doc: AgentTraceDoc;
  cursorMs: number;
  onCursorChange: (ms: number) => void;
  selectedLaneId: string | null;
  onSelectLane: (laneId: string | null) => void;
  /** Open a lane's asset (the lane *name* is the link, not the whole row).
   * Outline/Call-stack only — skill lanes resolve to their editor. */
  onOpenLane?: (laneId: string) => void;
  /** Override the lane rows (e.g. the high-level `outline`). The time axis and
   * the cost strips always derive from the full `doc`, so they stay identical
   * to the Execution view. Each lane may carry its own `events`/`markers` and a
   * `depth` for nested indentation. Defaults to `doc.lanes`. */
  displayLanes?: TraceLane[];
  /** Controlled zoom window (ms). When `onZoomChange` is supplied the timeline
   * is controlled — zoom lives in the parent (e.g. URL-backed) so it survives
   * reloads and steps with browser back/forward. Omit both for internal state. */
  zoom?: [number, number] | null;
  onZoomChange?: (zoom: [number, number] | null) => void;
}

/**
 * Bottom timeline strip: one thin row per lane (root first) with severity-
 * colored segment bars and marker dots, a shared cursor line across all rows,
 * and a slider thumb beneath for scrubbing.
 */
export function TraceTimeline({
  doc,
  cursorMs,
  onCursorChange,
  selectedLaneId,
  onSelectLane,
  onOpenLane,
  displayLanes,
  zoom: zoomProp,
  onZoomChange,
}: TraceTimelineProps) {
  // Memoized so the markers/events grouping memo doesn't bust on every cursor
  // tick (a bare `displayLanes ?? doc.lanes` is a fresh ref each render).
  const lanes = useMemo(() => displayLanes ?? doc.lanes, [displayLanes, doc]);
  const outlineMode = displayLanes != null;
  const gutter = outlineMode ? GUTTER : 0;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    // Seed with the current size — ResizeObserver only fires on changes.
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { tMin, span } = useMemo(() => {
    const stamps = doc.lanes
      .flatMap((l) => [tsMs(l.start_ts), tsMs(l.end_ts)])
      .filter((v): v is number => v !== null);
    if (stamps.length === 0) return { tMin: 0, span: 1 };
    const lo = Math.min(...stamps);
    return { tMin: lo, span: Math.max(1, Math.max(...stamps) - lo) };
  }, [doc]);

  // Outline-only: drag-selected zoom window (ms). Lanes/events scale to it; the
  // cost strips below stay full-range and just highlight this band. Controlled
  // by the parent (URL-backed) when `onZoomChange` is given; internal otherwise.
  const [internalZoom, setInternalZoom] = useState<[number, number] | null>(null);
  const zoom = onZoomChange ? (zoomProp ?? null) : internalZoom;
  const setZoom = onZoomChange ?? setInternalZoom;
  const viewMin = zoom ? zoom[0] : tMin;
  const viewSpan = zoom ? Math.max(1, zoom[1] - zoom[0]) : span;

  const trackW = Math.max(1, width - gutter);
  // Lanes/events axis — honors the zoom window. Maps into [gutter, width].
  const x = useCallback(
    (ms: number | null): number | null =>
      ms === null || width === 0 ? null : gutter + ((ms - viewMin) / viewSpan) * trackW,
    [width, gutter, trackW, viewMin, viewSpan],
  );
  const cursorX = x(cursorMs);

  // px (within the track, clamped) → ms in the *current* view, so dragging on an
  // already-zoomed track narrows further.
  const msFromPx = useCallback(
    (px: number) => {
      const frac = Math.min(1, Math.max(0, (px - gutter) / trackW));
      return viewMin + frac * viewSpan;
    },
    [gutter, trackW, viewMin, viewSpan],
  );

  // Drag-to-select. dragRect holds the live [startPx, curPx] for the overlay.
  const [dragRect, setDragRect] = useState<[number, number] | null>(null);
  const onTrackMouseDown = (e: React.MouseEvent) => {
    if (!outlineMode || width === 0) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startPx = e.clientX - rect.left;
    setDragRect([startPx, startPx]);
    const onMove = (ev: MouseEvent) => setDragRect([startPx, ev.clientX - rect.left]);
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const endPx = ev.clientX - rect.left;
      setDragRect(null);
      if (Math.abs(endPx - startPx) < MIN_DRAG_PX) return;
      const a = msFromPx(Math.min(startPx, endPx));
      const b = msFromPx(Math.max(startPx, endPx));
      if (b - a > 0) setZoom([a, b]);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // The strips/lanes mark where the current zoom sits on the full axis.
  const band = zoom ? ([(zoom[0] - tMin) / span, (zoom[1] - tMin) / span] as const) : null;

  // Group once — per-lane .filter() inside the render loop would rescan all
  // markers/events for every lane on every render.
  const { markersByLane, eventsByLane } = useMemo(() => {
    const markers = new Map<string, TraceMarker[]>();
    const events = new Map<string, TraceEvent[]>();
    const keepEvent = (k: string) => OUTLINE_EVENT_KINDS.has(k);
    if (outlineMode) {
      // Outline lanes carry their own events/markers (plan spans / interrupts).
      for (const lane of lanes) {
        if (lane.markers?.length) markers.set(lane.id, lane.markers);
        const evs = (lane.events ?? []).filter((e) => keepEvent(e.kind));
        if (evs.length) events.set(lane.id, evs);
      }
    } else {
      for (const m of doc.markers) {
        (markers.get(m.lane_id) ?? markers.set(m.lane_id, []).get(m.lane_id)!).push(m);
      }
      for (const e of doc.events) {
        if (!keepEvent(e.kind)) continue;
        (events.get(e.lane_id) ?? events.set(e.lane_id, []).get(e.lane_id)!).push(e);
      }
    }
    return { markersByLane: markers, eventsByLane: events };
  }, [doc, lanes, outlineMode]);

  const EMPTY_MARKERS: TraceMarker[] = useMemo(() => [], []);
  const EMPTY_EVENTS: TraceEvent[] = useMemo(() => [], []);

  // Clicking an event zooms in around it until it's isolated enough to render as
  // a labelled chip — window = 3× the gap to its nearest same-lane neighbour
  // (so the neighbour lands a third of the track away, well past CHIP_MIN_PX).
  const zoomToEvent = useCallback(
    (laneId: string, ms: number) => {
      const evs = eventsByLane.get(laneId) ?? [];
      let dt = Infinity;
      for (const ev of evs) {
        const t = tsMs(ev.ts);
        if (t === null || t === ms) continue;
        dt = Math.min(dt, Math.abs(t - ms));
      }
      if (!Number.isFinite(dt)) dt = span * 0.04; // lone event → a small default window
      const half = Math.max(dt * 1.5, 1000);
      setZoom([ms - half, ms + half]);
    },
    [eventsByLane, span, setZoom],
  );

  // Bucketed activity (lane-time) and spend ($) series over the session.
  // Derived from segments: each segment spreads its duration and cost_usd
  // uniformly across the buckets it overlaps — view-only, no extra trace data.
  const { timeSeries, costSeries, totalCostSeries, bucketMs } = useMemo(() => {
    const n = Math.max(60, Math.floor(width / 4) || 0);
    const bMs = span / n;
    const { time, cost } = bucketSegments(doc.lanes, tMin, bMs, n);
    const cumulative: number[] = [];
    let running = 0;
    for (const c of cost) cumulative.push((running += c));
    return { timeSeries: time, costSeries: cost, totalCostSeries: cumulative, bucketMs: bMs };
  }, [doc, width, tMin, span]);

  const cursorBucket = Math.min(
    timeSeries.length - 1,
    Math.max(0, Math.floor((cursorMs - tMin) / bucketMs)),
  );

  const strips = (
    // In outline mode the strips start at the gutter so they line up under the
    // time track (and the zoom band lands over the right window).
    <div style={{ paddingLeft: gutter }}>
      <SeriesStrip
        label="time"
        values={timeSeries}
        color="rgb(14 165 233)"
        atCursor={`${(timeSeries[cursorBucket] / bucketMs || 0).toFixed(1)}× active`}
        band={band}
        testId="trace-strip-time"
      />
      <SeriesStrip
        label="$/h"
        values={costSeries}
        color="rgb(16 185 129)"
        atCursor={`$${((costSeries[cursorBucket] / bucketMs || 0) * 3_600_000).toFixed(2)}/h`}
        band={band}
        testId="trace-strip-cost"
      />
      <SeriesStrip
        label="Σ$"
        values={totalCostSeries}
        color="rgb(168 85 247)"
        atCursor={`$${(totalCostSeries[cursorBucket] || 0).toFixed(2)} spent`}
        band={band}
        testId="trace-strip-total-cost"
      />
    </div>
  );
  const laneRows = (
    <div
      className={cn('relative overflow-y-auto overflow-x-hidden', outlineMode && 'min-h-0 flex-1')}
      style={outlineMode ? undefined : { maxHeight: MAX_VISIBLE_LANES_PX }}
      data-testid="trace-timeline-lanes"
    >
      {lanes.map((lane) => (
        <LaneRow
          key={lane.id}
          lane={lane}
          outline={outlineMode}
          markers={markersByLane.get(lane.id) ?? EMPTY_MARKERS}
          events={eventsByLane.get(lane.id) ?? EMPTY_EVENTS}
          x={x}
          selected={selectedLaneId === lane.id}
          onSelect={onSelectLane}
          onOpen={onOpenLane}
          onZoomEvent={zoomToEvent}
        />
      ))}
      {outlineMode && (
        <>
          {/* Drag-to-zoom capture layer over the track (right of the gutter). The
              skill-name links live in the gutter, so they stay clickable. */}
          <div
            className="absolute inset-y-0 z-10 cursor-crosshair"
            style={{ left: gutter, right: 0 }}
            onMouseDown={onTrackMouseDown}
            onDoubleClick={() => setZoom(null)}
            data-testid="trace-zoom-capture"
          />
          {dragRect && (
            <div
              className="pointer-events-none absolute inset-y-0 z-30 border-x border-primary/60 bg-primary/15"
              style={{
                left: Math.min(dragRect[0], dragRect[1]),
                width: Math.abs(dragRect[1] - dragRect[0]),
              }}
            />
          )}
          {cursorX !== null && (
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-foreground/70"
              style={{ left: cursorX }}
              data-testid="trace-cursor-line"
            />
          )}
          {zoom && (
            <button
              type="button"
              className="absolute right-1 top-1 z-40 flex items-center gap-1 rounded-full border bg-background/90 px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm hover:text-foreground"
              onClick={() => setZoom(null)}
              data-testid="trace-zoom-reset"
            >
              <Maximize2 className="h-3 w-3" />
              reset zoom
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={0}>
    <div
      className={cn('border-t px-3 pb-2 pt-1', outlineMode ? 'flex min-h-0 flex-1 flex-col' : 'flex-shrink-0')}
      data-testid="trace-timeline"
    >
      {/* Call-stack (outline) mode: lanes fill the top, cost graphs sit below —
          Execution mode keeps the compact strips-on-top layout. */}
      <div ref={trackRef} className={cn('relative', outlineMode && 'flex min-h-0 flex-1 flex-col')}>
        {outlineMode ? (
          <>
            {laneRows}
            {strips}
          </>
        ) : (
          <>
            {strips}
            {laneRows}
          </>
        )}
        {!outlineMode && cursorX !== null && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-foreground/70"
            style={{ left: cursorX }}
            data-testid="trace-cursor-line"
          />
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="w-14 flex-shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {formatOffset(cursorMs - tMin)}
        </span>
        <Slider
          min={tMin}
          max={tMin + span}
          step={1000}
          value={[cursorMs]}
          onValueChange={([v]) => onCursorChange(v)}
          data-testid="trace-cursor-slider"
        />
        <span className="w-14 flex-shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatOffset(span)}
        </span>
      </div>
    </div>
    </TooltipProvider>
  );
}

const STRIP_H = 22;

/** Compact area sparkline sharing the timeline's x-axis — one per metric. The
 * optional `band` ([start, end] as 0–1 fractions of the full session) shades the
 * currently zoomed window so the strips stay a stable "you are here" overview. */
function SeriesStrip({
  label,
  values,
  color,
  atCursor,
  band,
  testId,
}: {
  label: string;
  values: number[];
  color: string;
  atCursor: string;
  band?: readonly [number, number] | null;
  testId: string;
}) {
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const points = values
    .map((v, i) => `${((i + 0.5) / n) * 100},${STRIP_H - (v / max) * (STRIP_H - 2)}`)
    .join(' ');
  return (
    <div className="relative" style={{ height: STRIP_H }} data-testid={testId}>
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 100 ${STRIP_H}`}
        preserveAspectRatio="none"
      >
        <polygon points={`0,${STRIP_H} ${points} 100,${STRIP_H}`} fill={color} fillOpacity={0.18} />
        <polyline points={points} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {band && (
          <rect
            x={band[0] * 100}
            y={0}
            width={Math.max(0.5, (band[1] - band[0]) * 100)}
            height={STRIP_H}
            fill="currentColor"
            fillOpacity={0.12}
            className="text-foreground"
          />
        )}
      </svg>
      <span className="pointer-events-none absolute left-0.5 top-0 text-[9px] leading-none text-muted-foreground">
        {label}
      </span>
      <span className="pointer-events-none absolute right-0.5 top-0 font-mono text-[9px] leading-none text-muted-foreground">
        {atCursor}
      </span>
    </div>
  );
}

// Memoized: a cursor tick re-renders the parent ~dozens of times per drag;
// lane rows (70+ lanes × thousands of segment divs) only depend on layout.
function laneLabel(lane: TraceLane, outline: boolean): string {
  if (!outline) return lane.kind === 'root' ? 'root' : (lane.agent_type ?? lane.id);
  if (lane.kind === 'skill') return lane.skill_name ?? lane.description ?? lane.id;
  if (lane.kind === 'root') return lane.description ?? 'session';
  return lane.description ?? lane.agent_type ?? lane.id; // subagent → its role
}

/** Type icon for an outline lane. Entity-backed kinds (skill / subagent / tasks)
 * resolve through the backend type registry; the structural session/user lanes
 * use a fixed glyph. */
function laneIcon(lane: TraceLane): LucideIcon {
  switch (lane.kind) {
    case 'skill':
      return iconForType('skill');
    case 'subagent':
      return iconForType('agent');
    case 'tasks':
      return iconForType('task');
    case 'user':
      return User;
    case 'errors':
      return AlertTriangle;
    default:
      return SquareTerminal; // root / session
  }
}

const LaneRow = memo(function LaneRow({
  lane,
  outline,
  markers,
  events,
  x,
  selected,
  onSelect,
  onOpen,
  onZoomEvent,
}: {
  lane: TraceLane;
  outline: boolean;
  markers: TraceMarker[];
  events: TraceEvent[];
  x: (ms: number | null) => number | null;
  selected: boolean;
  onSelect: (laneId: string | null) => void;
  onOpen?: (laneId: string) => void;
  /** Outline only: zoom the timeline in around a clicked event until it's a chip. */
  onZoomEvent?: (laneId: string, ms: number) => void;
}) {
  const label = laneLabel(lane, outline);
  // Outline lanes nest by depth (label indent) and need a wider, legible label
  // backdrop since skill/role names sit over their span bars.
  const indentPx = outline ? (lane.depth ?? 0) * 12 : 0;
  // Only the skill *name* opens its asset (a link) — NOT the whole row. In the
  // Execution view the row stays clickable for lane selection.
  const isLink = outline && lane.kind === 'skill' && !!onOpen;
  const Icon = outline ? laneIcon(lane) : null;
  // Skills and subagents share the same prominence (bold, full-size, type icon);
  // skills are additionally a primary-colored link since they open their asset.
  const labelTone = isLink
    ? 'pointer-events-auto cursor-pointer font-semibold text-primary hover:underline'
    : lane.kind === 'root' || lane.kind === 'subagent'
      ? 'pointer-events-none font-semibold text-foreground/80'
      : 'pointer-events-none font-medium text-foreground/60'; // user / tasks
  return (
    <div
      className={cn(
        'relative flex items-center',
        outline ? 'cursor-default overflow-hidden' : 'cursor-pointer',
        selected && 'rounded bg-accent/60',
      )}
      style={{ height: outline ? OUTLINE_ROW_H : LANE_ROW_H }}
      onClick={outline ? undefined : () => onSelect(selected ? null : lane.id)}
      title={outline ? label : lane.kind === 'root' ? 'root' : `${lane.agent_type ?? 'subagent'}: ${lane.description ?? lane.id}`}
      data-testid={`trace-lane-${lane.id}`}
    >
      {outline ? (
        <span
          className={cn('absolute inset-y-0 left-0 z-30 flex items-center gap-1.5 bg-background text-[13px] leading-none', labelTone)}
          style={{ width: GUTTER, paddingLeft: indentPx + 2 }}
          onClick={
            isLink
              ? (e) => {
                  e.stopPropagation();
                  onOpen?.(lane.id);
                }
              : undefined
          }
          title={isLink ? `Open ${label}` : label}
        >
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />}
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <span
          className="pointer-events-none absolute left-0 top-0 z-30 w-20 truncate pl-0.5 text-[9px] leading-none text-muted-foreground"
          style={{ paddingLeft: indentPx + 2 }}
        >
          {label}
        </span>
      )}
      {lane.segments.map((seg) => {
        const x0 = x(tsMs(seg.start_ts));
        const x1 = x(tsMs(seg.end_ts));
        if (x0 === null || x1 === null) return null;
        return (
          <div
            key={seg.id}
            className={cn(
              'absolute h-2 rounded-sm',
              outline ? outlineSegmentColor(lane.kind) : severityBar(seg.severity),
            )}
            style={{ left: x0, width: Math.max(2, x1 - x0) }}
            title={seg.label}
          />
        );
      })}
      {(() => {
        const exs = events.map((e) => x(tsMs(e.ts)));
        return events.map((e, i) => {
          const ex = exs[i];
          if (ex === null) return null;
          // At high zoom (markers spaced out) render the event as a labelled
          // chip with full info; otherwise keep the compact diamond.
          let gap = Infinity;
          for (let j = 0; j < exs.length; j++) {
            const o = exs[j];
            if (j === i || o === null) continue;
            gap = Math.min(gap, Math.abs(o - ex));
          }
          const title = `${e.kind.replace('_', ' ')}: ${e.label}`;
          const Icon = EVENT_ICON[e.kind];
          const asChip = outline && gap >= CHIP_MIN_PX;

          // Execution mode: plain diamond with a native tooltip (no zoom).
          if (!outline) {
            return (
              <div
                key={`ev-${e.ts}-${i}`}
                className={cn('absolute bottom-0 h-1.5 w-1.5 rotate-45 cursor-default', eventColor(e.kind, e.severity))}
                style={{ left: ex - 3 }}
                title={title}
                data-testid={`trace-event-${e.kind}`}
              />
            );
          }

          // Outline: clicking an event zooms in around it until it's a chip.
          const ms = tsMs(e.ts);
          const onClick = (ev: React.MouseEvent) => {
            ev.stopPropagation();
            if (ms !== null) onZoomEvent?.(lane.id, ms);
          };
          const marker = asChip ? (
            <div
              className="absolute top-1/2 z-20 flex h-5 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-full border bg-background px-1.5 text-[10px] text-foreground/80 shadow-sm"
              style={{ left: ex - 5, maxWidth: 220 }}
              onClick={onClick}
              data-testid={`trace-event-${e.kind}`}
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', eventColor(e.kind, e.severity))} />
              {Icon && <Icon className="h-3 w-3 shrink-0 opacity-70" />}
              <span className="truncate">{e.label}</span>
            </div>
          ) : (
            // Transparent 20px hit box so the small diamond is easy to click;
            // the visual marker (ringed dot) is centered inside it.
            <div
              className="absolute top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center"
              style={{ left: ex - 10 }}
              onClick={onClick}
              data-testid={`trace-event-${e.kind}`}
            >
              <span
                // Bigger, ringed dots so prompts / interrupts / tasks read
                // clearly against the lane bars.
                className={cn('h-2.5 w-2.5 rotate-45 rounded-[1px] ring-1 ring-background', eventColor(e.kind, e.severity))}
              />
            </div>
          );
          return (
            <Tooltip key={`ev-${e.ts}-${i}`}>
              <TooltipTrigger asChild>{marker}</TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {title}
              </TooltipContent>
            </Tooltip>
          );
        });
      })()}
      {markers.map((m, i) => {
        const mx = x(tsMs(m.ts));
        if (mx === null) return null;
        return (
          <div
            key={`${m.ts}-${i}`}
            className={cn(
              'absolute top-0 h-2 w-2 rounded-full ring-1 ring-background',
              markerColor(m),
            )}
            style={{ left: mx - 4 }}
            title={`${m.kind}: ${m.label}`}
            data-testid={`trace-marker-${m.kind}`}
          />
        );
      })}
    </div>
  );
});

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
