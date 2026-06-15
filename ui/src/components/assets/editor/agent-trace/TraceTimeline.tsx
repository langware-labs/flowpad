import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Slider } from '@src/components/ui/slider';
import { cn } from '@src/lib/utils';
import type { AgentTraceDoc, TraceEvent, TraceLane, TraceMarker } from './trace-types';
import { tsMs } from './trace-types';

const LANE_ROW_H = 14; // px per lane row
const MAX_VISIBLE_LANES_PX = 168; // ~12 rows before the lane list scrolls

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
}: TraceTimelineProps) {
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
    for (const m of doc.markers) {
      (markers.get(m.lane_id) ?? markers.set(m.lane_id, []).get(m.lane_id)!).push(m);
    }
    for (const e of doc.events) {
      if (e.kind !== 'skill_load' && e.kind !== 'skill_fail' && e.kind !== 'interrupt') continue;
      (events.get(e.lane_id) ?? events.set(e.lane_id, []).get(e.lane_id)!).push(e);
    }
    return { markersByLane: markers, eventsByLane: events };
  }, [doc]);

  const EMPTY_MARKERS: TraceMarker[] = useMemo(() => [], []);
  const EMPTY_EVENTS: TraceEvent[] = useMemo(() => [], []);

  // Bucketed activity (lane-time) and spend ($) series over the session.
  // Derived from segments: each segment spreads its duration and cost_usd
  // uniformly across the buckets it overlaps — view-only, no extra trace data.
  const { timeSeries, costSeries, totalCostSeries, bucketMs } = useMemo(() => {
    const n = Math.max(60, Math.floor(width / 4) || 0);
    const bMs = span / n;
    const time = new Array<number>(n).fill(0);
    const cost = new Array<number>(n).fill(0);
    for (const lane of doc.lanes) {
      for (const seg of lane.segments) {
        const s = tsMs(seg.start_ts);
        const e = tsMs(seg.end_ts);
        if (s === null || e === null || e <= s) continue;
        const first = Math.max(0, Math.floor((s - tMin) / bMs));
        const last = Math.min(n - 1, Math.floor((e - tMin) / bMs));
        for (let b = first; b <= last; b++) {
          const bStart = tMin + b * bMs;
          const overlap = Math.min(e, bStart + bMs) - Math.max(s, bStart);
          if (overlap <= 0) continue;
          time[b] += overlap; // lane-ms of activity in this bucket
          cost[b] += seg.cost_usd * (overlap / (e - s));
        }
      }
    }
    const cumulative: number[] = [];
    let running = 0;
    for (const c of cost) cumulative.push((running += c));
    return { timeSeries: time, costSeries: cost, totalCostSeries: cumulative, bucketMs: bMs };
  }, [doc, width, tMin, span]);

  const cursorBucket = Math.min(
    timeSeries.length - 1,
    Math.max(0, Math.floor((cursorMs - tMin) / bucketMs)),
  );

  return (
    <div className="flex-shrink-0 border-t px-3 pb-2 pt-1" data-testid="trace-timeline">
      <div ref={trackRef} className="relative">
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
        <div
          className="overflow-y-auto"
          style={{ maxHeight: MAX_VISIBLE_LANES_PX }}
          data-testid="trace-timeline-lanes"
        >
          {doc.lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              markers={markersByLane.get(lane.id) ?? EMPTY_MARKERS}
              events={eventsByLane.get(lane.id) ?? EMPTY_EVENTS}
              x={x}
              selected={selectedLaneId === lane.id}
              onSelect={onSelectLane}
            />
          ))}
        </div>
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
const LaneRow = memo(function LaneRow({
  lane,
  markers,
  events,
  x,
  selected,
  onSelect,
}: {
  lane: TraceLane;
  markers: TraceMarker[];
  events: TraceEvent[];
  x: (ms: number | null) => number | null;
  selected: boolean;
  onSelect: (laneId: string | null) => void;
}) {
  return (
    <div
      className={cn(
        'relative flex cursor-pointer items-center',
        selected && 'rounded bg-accent/60',
      )}
      style={{ height: LANE_ROW_H }}
      onClick={() => onSelect(selected ? null : lane.id)}
      title={lane.kind === 'root' ? 'root' : `${lane.agent_type ?? 'subagent'}: ${lane.description ?? lane.id}`}
      data-testid={`trace-lane-${lane.id}`}
    >
      <span className="pointer-events-none absolute left-0 z-10 w-20 truncate pl-0.5 text-[9px] leading-none text-muted-foreground">
        {lane.kind === 'root' ? 'root' : (lane.agent_type ?? lane.id)}
      </span>
      {lane.segments.map((seg) => {
        const x0 = x(tsMs(seg.start_ts));
        const x1 = x(tsMs(seg.end_ts));
        if (x0 === null || x1 === null) return null;
        return (
          <div
            key={seg.id}
            className={cn('absolute h-2 rounded-sm', severityBar(seg.severity))}
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
              'absolute bottom-0 h-1.5 w-1.5 rotate-45',
              e.kind === 'skill_fail' ? 'bg-red-500' : e.kind === 'interrupt' ? 'bg-amber-500' : 'bg-sky-500',
            )}
            style={{ left: ex - 3 }}
            title={`${e.kind}: ${e.label}`}
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
