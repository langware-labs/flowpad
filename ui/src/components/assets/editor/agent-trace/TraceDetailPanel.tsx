import { useMemo } from 'react';
import { cn } from '@src/lib/utils';
import type {
  AgentTraceDoc,
  CallFrame,
  TraceEvent,
  TraceGoal,
  TraceMarker,
  TraceSegment,
  TraceToolCall,
} from './trace-types';
import { tsMs } from './trace-types';
import { fmtDuration } from './format';

const MIN_NEARBY_WINDOW_MS = 30_000;
const MAX_CALLS_SHOWN = 12;

/** ±window for "markers near the cursor": 1% of the session span, floored at
 * 30s — on a multi-hour trace a fixed 30s is narrower than one timeline pixel. */
function nearbyWindowMs(doc: AgentTraceDoc): number {
  const stamps = doc.lanes
    .flatMap((l) => [tsMs(l.start_ts), tsMs(l.end_ts)])
    .filter((v): v is number => v !== null);
  if (stamps.length === 0) return MIN_NEARBY_WINDOW_MS;
  return Math.max(MIN_NEARBY_WINDOW_MS, (Math.max(...stamps) - Math.min(...stamps)) / 100);
}

interface TraceDetailPanelProps {
  doc: AgentTraceDoc;
  cursorMs: number;
  /** Lane to detail; null = root lane. */
  selectedLaneId: string | null;
  /** When a call-tree frame is picked, show its frame-scoped detail on top. */
  selectedFrame?: CallFrame | null;
}

function activeSegment(segments: TraceSegment[], cursorMs: number): TraceSegment | null {
  let best: TraceSegment | null = null;
  for (const seg of segments) {
    const s = tsMs(seg.start_ts);
    if (s === null || s > cursorMs) break;
    const e = tsMs(seg.end_ts);
    if (e !== null && e >= cursorMs) return seg;
    best = seg; // most recent segment that started before the cursor
  }
  return best;
}

function severityText(severity: string): string {
  return severity === 'attention'
    ? 'text-red-500'
    : severity === 'notable'
      ? 'text-amber-500'
      : 'text-muted-foreground';
}

/**
 * "What was the agent doing at the cursor": active goal/subgoal spans from the
 * annotations, the active segment of the selected lane with the tool calls
 * around the cursor, and any markers within ±30s.
 */
export function TraceDetailPanel({
  doc,
  cursorMs,
  selectedLaneId,
  selectedFrame,
}: TraceDetailPanelProps) {
  const laneId = selectedLaneId ?? 'root';
  const lane = doc.lanes.find((l) => l.id === laneId) ?? doc.lanes[0];

  const seg = useMemo(() => (lane ? activeSegment(lane.segments, cursorMs) : null), [lane, cursorMs]);

  const activeGoals = useMemo(
    () =>
      (doc.annotations?.goals ?? []).filter((g) => {
        const s = tsMs(g.start_ts);
        const e = tsMs(g.end_ts);
        return s !== null && s <= cursorMs && (e === null || e >= cursorMs);
      }),
    [doc, cursorMs],
  );

  const nearbyMarkers = useMemo(() => {
    const window = nearbyWindowMs(doc);
    return doc.markers.filter((m) => {
      const ms = tsMs(m.ts);
      return ms !== null && Math.abs(ms - cursorMs) <= window;
    });
  }, [doc, cursorMs]);

  const nearbyEvents = useMemo(() => {
    const window = nearbyWindowMs(doc);
    return doc.events.filter((e) => {
      if (e.kind === 'user_prompt') return false; // already the segment label
      const ms = tsMs(e.ts);
      return ms !== null && Math.abs(ms - cursorMs) <= window;
    });
  }, [doc, cursorMs]);

  const callsAroundCursor = useMemo(() => {
    if (!seg) return [];
    const upTo = seg.tool_calls.filter((c) => {
      const ms = tsMs(c.ts);
      return ms !== null && ms <= cursorMs;
    });
    return upTo.slice(-MAX_CALLS_SHOWN);
  }, [seg, cursorMs]);

  if (!lane) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Empty trace
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" data-testid="trace-detail-panel">
      {selectedFrame && <FrameDetail frame={selectedFrame} />}

      {activeGoals.length > 0 && (
        <div className="space-y-0.5">
          {activeGoals.map((g, i) => (
            <GoalLine key={i} goal={g} cursorMs={cursorMs} />
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {lane.kind === 'root' ? 'root' : (lane.agent_type ?? lane.id)}
        </span>
        {lane.description ? <span> — {lane.description}</span> : null}
        {seg?.label ? <span> · {seg.label}</span> : null}
        {seg ? <span> · ${seg.cost_usd.toFixed(2)}</span> : null}
      </div>

      {(nearbyMarkers.length > 0 || nearbyEvents.length > 0) && (
        <div className="space-y-1" data-testid="trace-nearby-markers">
          {nearbyMarkers.map((m, i) => (
            <MarkerLine key={`${m.ts}-${i}`} marker={m} />
          ))}
          {nearbyEvents.map((e, i) => (
            <EventLine key={`ev-${e.ts}-${i}`} event={e} />
          ))}
        </div>
      )}

      <div className="space-y-0.5 font-mono text-[11px]" data-testid="trace-call-list">
        {callsAroundCursor.length === 0 && (
          <div className="text-muted-foreground">No tool calls before cursor in this segment</div>
        )}
        {callsAroundCursor.map((c) => (
          <CallLine key={c.entry_id} call={c} />
        ))}
      </div>
    </div>
  );
}

function GoalLine({ goal, cursorMs }: { goal: TraceGoal; cursorMs: number }) {
  const activeSub = (goal.subgoals ?? []).find((sg) => {
    const s = tsMs(sg.start_ts);
    const e = tsMs(sg.end_ts);
    return s !== null && s <= cursorMs && (e === null || e >= cursorMs);
  });
  return (
    <div className="text-sm">
      <span className={cn('font-medium', goal.verdict === 'bad' && 'text-red-500')}>
        {goal.label}
      </span>
      {activeSub && <span className="text-muted-foreground"> → {activeSub.label}</span>}
    </div>
  );
}

function MarkerLine({ marker }: { marker: TraceMarker }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span
        className={cn(
          'rounded px-1 font-medium uppercase tracking-wide',
          marker.kind === 'divergence'
            ? 'bg-purple-500/15 text-purple-500'
            : 'bg-red-500/15 text-red-500',
        )}
      >
        {marker.kind}
      </span>
      <span className="min-w-0 flex-1">
        {marker.label}
        {marker.detail ? <span className="text-muted-foreground"> — {marker.detail}</span> : null}
      </span>
    </div>
  );
}

function EventLine({ event }: { event: TraceEvent }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span
        className={cn(
          'rounded px-1 font-medium uppercase tracking-wide',
          event.kind === 'skill_fail'
            ? 'bg-red-500/15 text-red-500'
            : event.kind === 'interrupt'
              ? 'bg-amber-500/15 text-amber-600'
              : 'bg-sky-500/15 text-sky-600',
        )}
      >
        {event.kind.replace('_', ' ')}
      </span>
      <span className="min-w-0 flex-1 truncate">{event.label}</span>
    </div>
  );
}

function CallLine({ call }: { call: TraceToolCall }) {
  return (
    <div className="flex items-baseline gap-1.5 truncate">
      <span className={cn('flex-shrink-0', severityText(call.severity))}>
        {call.skill_name ? `skill:${call.skill_name}` : call.tool_name || call.kind}
      </span>
      <span className="truncate text-muted-foreground">{call.preview}</span>
      {call.exit_code != null && call.exit_code !== 0 && (
        <span className="flex-shrink-0 text-red-500">exit {call.exit_code}</span>
      )}
    </div>
  );
}

/** Frame-scoped header shown when a call-tree frame is selected. Summarizes the
 * frame's policies, rolled-up totals, and its immediate children. */
function FrameDetail({ frame }: { frame: CallFrame }) {
  return (
    <div className="rounded-md border bg-muted/30 p-2" data-testid="frame-detail">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">{frame.callable}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{frame.kind}</span>
        {[frame.context_policy, frame.control_policy, frame.state_scope].map((p) => (
          <span key={p} className="rounded bg-background px-1 text-[10px] text-muted-foreground">
            {p}
          </span>
        ))}
        {frame.mcp && <span className="text-[10px] text-teal-500">mcp</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{fmtDuration(frame.total_duration_ms)}</span>
        {frame.total_cost_usd > 0 && <span>${frame.total_cost_usd.toFixed(2)}</span>}
        <span className={frame.issue_count > 0 ? 'text-red-500' : ''}>{frame.issue_count} issues</span>
        <span>{frame.tool_call_count} tool calls</span>
        {frame.issues_per_usd != null && <span>{frame.issues_per_usd}/$</span>}
        {frame.issues_per_min != null && <span>{frame.issues_per_min}/min</span>}
      </div>
      {frame.children.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t pt-1 font-mono text-[11px]">
          {frame.children.slice(0, 20).map((c) => (
            <div key={c.id} className="flex items-baseline gap-1.5 truncate">
              <span className={cn('flex-shrink-0', severityText(c.worst_severity))}>{c.kind}</span>
              <span className="truncate text-muted-foreground">{c.callable}</span>
              {c.total_cost_usd > 0 && (
                <span className="flex-shrink-0 text-muted-foreground">${c.total_cost_usd.toFixed(2)}</span>
              )}
              {c.issue_count > 0 && <span className="flex-shrink-0 text-red-500">⚠{c.issue_count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
