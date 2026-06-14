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
  kind: 'root' | 'subagent';
  agent_type?: string | null;
  description?: string | null;
  parent_lane_id?: string | null;
  spawn_tool_use_id?: string | null;
  start_ts?: string | null;
  end_ts?: string | null;
  segments: TraceSegment[];
}

export interface TraceEvent {
  ts: string;
  lane_id: string;
  kind: 'user_prompt' | 'skill_load' | 'skill_fail' | 'agent_spawn' | 'interrupt';
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
