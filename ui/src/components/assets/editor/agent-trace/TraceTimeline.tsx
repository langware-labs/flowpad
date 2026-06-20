import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Slider } from '@src/components/ui/slider';
import { cn } from '@src/lib/utils';
import type { AgentTraceDoc, TraceEvent, TraceLane, TraceMarker } from './trace-types';
import { bucketSegments, tsMs } from './trace-types';

const LANE_ROW_H = 14; // px per lane row (compact Execution strip)
const OUTLINE_ROW_H = 24; // taller rows for the readable Call-stack timeline
const MAX_VISIBLE_LANES_PX = 168; // ~12 rows before the lane list scrolls

// Outline-only event kinds surfaced on the timeline.
const OUTLINE_EVENT_KINDS = new Set(['skill_load', 'skill_fail', 'interrupt', 'task_create', 'task_update']);

/** Color for an outline lane's span bar (skills/plan/subagent). */
function outlineSegmentColor(laneKind: string): string {
  if (laneKind === 'skill') return 'bg-primary/60';
  if (laneKind === 'root') return 'bg-amber-500/50'; // plan-mode spans
  return 'bg-sky-500/45'; // subagent span
}

/** Color for an event diamond by kind (task completion bumps the shade). */
function eventColor(kind: string, severity: string): string {
  switch (kind) {
    case 'skill_fail':
      return 'bg-red-500';
    case 'interrupt':
      return 'bg-amber-500';
    case 'task_create':
      return 'bg-emerald-400';
    case 'task_update':
      return severity === 'notable' ? 'bg-emerald-600' : 'bg-violet-500';
    default:
      return 'bg-sky-500';
  }
}

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
  /** Override the lane rows (e.g. the high-level `outline`). The time axis and
   * the cost strips always derive from the full `doc`, so they stay identical
   * to the Execution view. Each lane may carry its own `events`/`markers` and a
   * `depth` for nested indentation. Defaults to `doc.lanes`. */
  displayLanes?: TraceLane[];
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
  displayLanes,
}: TraceTimelineProps) {
  // Memoized so the markers/events grouping memo doesn't bust on every cursor
  // tick (a bare `displayLanes ?? doc.lanes` is a fresh ref each render).
  const lanes = useMemo(() => displayLanes ?? doc.lanes, [displayLanes, doc]);
  const outlineMode = displayLanes != null;
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

  // Stable across cursor moves so memoized LaneRows don't re-render per tick.
  const x = useCallback(
    (ms: number | null): number | null =>
      ms === null || width === 0 ? null : ((ms - tMin) / span) * width,
    [width, tMin, span],
  );

  const cursorX = x(cursorMs);

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
    <>
      <SeriesStrip
        label="time"
        values={timeSeries}
        color="rgb(14 165 233)"
        atCursor={`${(timeSeries[cursorBucket] / bucketMs || 0).toFixed(1)}× active`}
        testId="trace-strip-time"
      />
      <SeriesStrip
        label="$/h"
        values={costSeries}
        color="rgb(16 185 129)"
        atCursor={`$${((costSeries[cursorBucket] / bucketMs || 0) * 3_600_000).toFixed(2)}/h`}
        testId="trace-strip-cost"
      />
      <SeriesStrip
        label="Σ$"
        values={totalCostSeries}
        color="rgb(168 85 247)"
        atCursor={`$${(totalCostSeries[cursorBucket] || 0).toFixed(2)} spent`}
        testId="trace-strip-total-cost"
      />
    </>
  );
  const laneRows = (
    <div
      className={cn('overflow-y-auto overflow-x-hidden', outlineMode && 'min-h-0 flex-1')}
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
        />
      ))}
    </div>
  );

  return (
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
        {cursorX !== null && (
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
  );
}

const STRIP_H = 22;

/** Compact area sparkline sharing the timeline's x-axis — one per metric. */
function SeriesStrip({
  label,
  values,
  color,
  atCursor,
  testId,
}: {
  label: string;
  values: number[];
  color: string;
  atCursor: string;
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

const LaneRow = memo(function LaneRow({
  lane,
  outline,
  markers,
  events,
  x,
  selected,
  onSelect,
}: {
  lane: TraceLane;
  outline: boolean;
  markers: TraceMarker[];
  events: TraceEvent[];
  x: (ms: number | null) => number | null;
  selected: boolean;
  onSelect: (laneId: string | null) => void;
}) {
  const label = laneLabel(lane, outline);
  // Outline lanes nest by depth (label indent) and need a wider, legible label
  // backdrop since skill/role names sit over their span bars.
  const indentPx = outline ? (lane.depth ?? 0) * 12 : 0;
  // Skill lanes open their asset on click → render as links.
  const isLink = outline && lane.kind === 'skill';
  return (
    <div
      className={cn(
        'relative flex items-center',
        outline && lane.kind === 'skill' ? 'cursor-pointer' : 'cursor-default',
        !outline && 'cursor-pointer',
        selected && 'rounded bg-accent/60',
      )}
      style={{ height: outline ? OUTLINE_ROW_H : LANE_ROW_H }}
      onClick={() => onSelect(selected ? null : lane.id)}
      title={outline ? label : lane.kind === 'root' ? 'root' : `${lane.agent_type ?? 'subagent'}: ${lane.description ?? lane.id}`}
      data-testid={`trace-lane-${lane.id}`}
    >
      <span
        className={cn(
          'pointer-events-none absolute left-0 z-10 truncate pl-0.5 leading-none',
          outline
            ? cn(
                'inset-y-0 flex w-56 items-center rounded-sm bg-background/85 text-[13px]',
                isLink
                  ? 'font-semibold text-primary'
                  : lane.kind === 'root'
                    ? 'font-semibold text-foreground/80'
                    : 'text-foreground/70',
              )
            : 'top-0 w-20 text-[9px] text-muted-foreground',
        )}
        style={{ paddingLeft: indentPx + 2 }}
      >
        {label}
      </span>
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
      {events.map((e, i) => {
        const ex = x(tsMs(e.ts));
        if (ex === null) return null;
        return (
          <div
            key={`ev-${e.ts}-${i}`}
            className={cn(
              'absolute bottom-0 rotate-45',
              outline ? 'h-2 w-2' : 'h-1.5 w-1.5',
              eventColor(e.kind, e.severity),
            )}
            style={{ left: ex - 3 }}
            title={`${e.kind.replace('_', ' ')}: ${e.label}`}
            data-testid={`trace-event-${e.kind}`}
          />
        );
      })}
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
