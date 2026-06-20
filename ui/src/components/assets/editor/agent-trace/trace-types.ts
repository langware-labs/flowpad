/** TS mirror of the AgentTrace JSON schema v1 — see
 * flow_sdk/transcript_analyzer/synthesizers/agent_trace.py. */

export interface TraceToolCall {
  ts: string;
  kind: string;
  tool_name: string;
  skill_name?: string | null;
  exit_code?: number | null;
  duration_ms?: number | null;
  severity: string;
  preview: string;
  entry_id: string;
}

export interface TraceSegment {
  id: string;
  start_ts: string;
  end_ts: string;
  label: string;
  cost_usd: number;
  severity: string;
  tool_calls: TraceToolCall[];
}

export interface TraceLane {
  id: string;
  kind: 'root' | 'subagent' | 'skill' | 'tasks' | 'user';
  agent_type?: string | null;
  description?: string | null;
  parent_lane_id?: string | null;
  spawn_tool_use_id?: string | null;
  start_ts?: string | null;
  end_ts?: string | null;
  segments: TraceSegment[];
  // Outline-only (high-level "Call stack" lanes): nesting depth, the owning
  // skill name, and the lane's own events/markers (plan spans / interrupts).
  depth?: number;
  skill_name?: string | null;
  events?: TraceEvent[];
  markers?: TraceMarker[];
}

export interface TraceEvent {
  ts: string;
  lane_id: string;
  kind: 'user_prompt' | 'skill_load' | 'skill_fail' | 'agent_spawn' | 'interrupt' | 'task_create' | 'task_update';
  label: string;
  severity: string;
  entry_id: string;
}

export interface TraceMarker {
  ts: string;
  lane_id: string;
  kind: 'issue' | 'divergence' | 'stuck';
  severity: string;
  label: string;
  detail: string;
  source: 'synthesizer' | 'skill';
}

export interface TraceGoal {
  label: string;
  lane_id?: string;
  start_ts?: string;
  end_ts?: string;
  verdict?: string;
  subgoals?: { label: string; start_ts?: string; end_ts?: string }[];
}

export interface TraceAnnotations {
  goals: TraceGoal[];
  divergences: unknown[];
  verdict?: string | null;
  notes: string[];
}

export interface TraceSummary {
  verdict?: string | null;
  verdict_reason?: string | null;
  duration_ms: number;
  cost_usd: number;
  issue_count: number;
  divergence_count: number;
  lane_count: number;
  tool_call_count: number;
}

/** A node in the call-stack tree (schema v2). See
 * flow_sdk/transcript_analyzer/synthesizers/agent_trace.py `_build_call_tree`. */
export interface CallFrame {
  id: string;
  kind: 'session' | 'skill' | 'subagent' | 'tool' | 'compaction';
  callable: string;
  label: string;
  lane_id: string;
  entry_id?: string | null;
  context_policy: string;
  control_policy: string;
  state_scope: string;
  mcp: boolean;
  start_ts?: string | null;
  end_ts?: string | null;
  self_cost_usd: number;
  total_cost_usd: number;
  self_duration_ms: number;
  total_duration_ms: number;
  tool_call_count: number;
  issue_count: number;
  worst_severity: string;
  issues_per_usd?: number | null;
  issues_per_min?: number | null;
  children: CallFrame[];
}

export interface AgentTraceDoc {
  version: number;
  id?: string | null;
  name: string;
  session_id: string;
  worker_type: string;
  generated_at: string;
  summary: TraceSummary;
  lanes: TraceLane[];
  /** High-level "session call stack" lanes (root → skills → subagents), nested
   * by depth — drives the Call stack tab. Absent on older records. */
  outline?: TraceLane[];
  call_tree?: CallFrame; // v2+; absent on older records
  events: TraceEvent[];
  markers: TraceMarker[];
  annotations: TraceAnnotations;
}

export function tsMs(ts?: string | null): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Spread each segment's active time and cost across the `n` buckets of width
 * `bMs` it overlaps (proportional to overlap). The single source of the
 * segment→bucket math shared by the timeline strips and {@link peakCostPerHour}
 * — callers pick their own bucket sizing.
 */
export function bucketSegments(
  lanes: TraceLane[],
  tMin: number,
  bMs: number,
  n: number,
): { time: number[]; cost: number[] } {
  const time = new Array<number>(n).fill(0);
  const cost = new Array<number>(n).fill(0);
  for (const lane of lanes) {
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
  return { time, cost };
}

/**
 * Peak spend rate ($/h) across the session — the headline burn rate.
 *
 * Buckets segment cost into ≥5-minute windows (width-independent, so the
 * banner number is stable regardless of timeline render width) and returns the
 * hottest bucket's rate.
 */
export function peakCostPerHour(doc: AgentTraceDoc): number {
  const stamps = doc.lanes
    .flatMap((l) => [tsMs(l.start_ts), tsMs(l.end_ts)])
    .filter((v): v is number => v !== null);
  if (stamps.length === 0) return 0;
  const tMin = Math.min(...stamps);
  const span = Math.max(1, Math.max(...stamps) - tMin);
  const bMs = Math.max(span / 240, 5 * 60_000); // ≥5-min buckets
  const n = Math.max(1, Math.ceil(span / bMs));
  const { cost } = bucketSegments(doc.lanes, tMin, bMs, n);
  let peak = 0;
  for (const c of cost) peak = Math.max(peak, (c / bMs) * 3_600_000);
  return peak;
}
