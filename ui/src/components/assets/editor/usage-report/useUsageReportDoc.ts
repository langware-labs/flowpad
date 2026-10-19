import { FSRef } from '@sdk';
import { useJsonDoc } from '@src/hooks/use-json-doc';

/** A session's slice of the report — mirrors the backend SessionRow. */
export interface UsageSessionRow {
  session_id: string;
  title: string;
  cwd: string;
  project: string;
  start: string | null;
  duration_ms: number;
  cost_usd: number;
  total_tokens: number;
  prompt_count: number;
  skills: string[];
  agents: string[];
  tool_failures: number;
  agent_trace_id?: string | null;
}

/** The full report payload — mirrors the backend UsageReportData. */
export interface UsageReportData {
  period_start: string;
  period_end: string;
  period_kind: string;
  generated_at: string;
  total_cost_usd: number;
  session_count: number;
  total_duration_ms: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_hit_rate: number;
  prompt_count: number;
  skill_invocations: number;
  agent_spawns: number;
  top_skills: { name: string; count: number }[];
  top_agents: { type: string; count: number }[];
  top_tools: { name: string; count: number }[];
  models: { model: string; cost_usd: number }[];
  sample_prompts: string[];
  busiest_session_id?: string | null;
  most_expensive_session_id?: string | null;
  sessions: UsageSessionRow[];
}

interface ReportDoc {
  id?: string;
  name?: string;
  data?: UsageReportData;
  markdown?: string;
}

/** The report.json behind a UsageReport entity, projected to its payload. */
export function useUsageReportDoc(fsRef: FSRef | null) {
  const { doc, error, loading } = useJsonDoc<ReportDoc>(fsRef);
  return { data: doc?.data ?? null, markdown: doc?.markdown ?? '', error, loading };
}
