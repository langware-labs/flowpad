/**
 * TS types for the WorkflowTraceViewer.
 *
 * Mirrors the backend Pydantic schemas:
 *   - flow_sdk/fs_records/workflow_report_entry.py  (WorkflowReportEntry)
 *   - flow_sdk/system_projects/flowpad_assistant/.claude/skills/session_analysis/SKILL.md
 *     (Workflow Mode analysis record schema)
 *
 * SCHEMA DRIFT DISCIPLINE
 * -----------------------
 * If either of those backend schemas change, this file MUST be updated AND
 * /tmp/run_workflow_demo.py re-run so the on-disk artifacts match.
 * Otherwise the viewer is rendering against stale fixtures and any drift is
 * silently masked.
 */

// ─── Trace event (one line of workflow.trace.jsonl) ──────────────────────────

export type TraceStatus =
  | "enter"
  | "done"
  | "error"
  | "skip"
  | "true"
  | "false";

export type TraceKind = "step" | "condition" | "call" | "return";

export interface WorkflowReportEntry {
  ts: string; // ISO 8601
  kind: TraceKind;
  file: string;
  line: number;
  status: TraceStatus;
  detail?: string | null;
  label?: string | null;
  target?: string | null;
}

// ─── Analysis record (one line of workflow.analysis.jsonl) ───────────────────

export type AnalysisIssueKind =
  | "incomplete"
  | "wrong_tool"
  | "retry"
  | "mid_run_toolsearch"
  | "protocol_violation"
  // Forward-compat: tolerate unknown issue kinds from future analyzer
  // versions without breaking the viewer.
  | string;

export interface AnalysisIssue {
  kind: AnalysisIssueKind;
  detail: string;
}

export interface AnalysisToolCall {
  name: string;
  result_summary: string;
}

export type AnalyzedStatus = "done" | "error" | "skip" | "incomplete";

export interface AnalysisRecord {
  anchor: { file: string; line: number };
  step_text: string;
  trace: {
    enter_ts: string;
    done_ts: string;
    duration_ms: number;
    status: AnalyzedStatus;
    detail?: string | null;
  };
  transcript_span: {
    start_uuid: string;
    end_uuid: string;
    tool_calls: AnalysisToolCall[];
  };
  issues: AnalysisIssue[];
  recommendation?: string | null;
}

// ─── View-models the components consume ─────────────────────────────────────

export interface StepViewModel {
  /** absolute path of the workflow file the step lives in */
  file: string;
  /** 1-indexed line number within `file` */
  line: number;
  /** the bullet text — from analysis.step_text or read from the workflow file */
  step_text: string;
  /** terminal status; "incomplete" if no done/error/skip event was paired */
  status: AnalyzedStatus;
  /** millis between enter_ts and terminal_ts; absent if step is incomplete */
  duration_ms?: number;
  /** short summary from the trace entry (e.g. "navigated to ...") */
  detail?: string;
  /** tool calls that ran during this step; absent without analysis */
  tool_calls?: AnalysisToolCall[];
  /** issues + recommendation; empty array when the step ran clean */
  issues: AnalysisIssue[];
  recommendation?: string;
}

export interface RunSummary {
  /** number of steps with status="done" and zero issues */
  cleanCount: number;
  /** number of steps with status="done" but at least one issue */
  warnCount: number;
  /** number of steps with status="error" */
  errorCount: number;
  /** number of steps with status="incomplete" or "skip" */
  pendingCount: number;
  /** sum of all step durations in ms (steps without duration excluded) */
  totalDurationMs: number;
  /** total number of step view-models */
  total: number;
}

export interface WorkflowTraceViewModel {
  /** absolute path of the workflow markdown file */
  workflowFile: string;
  /** raw full markdown content of the workflow file (frontmatter + body). */
  fullText: string;
  /** raw markdown content split at `## Steps` (header section only). */
  header: string;
  /** view-model per step, in line order */
  steps: StepViewModel[];
  /** aggregate counts/duration across all steps */
  summary: RunSummary;
  /** true while loading any of the three input files */
  isLoading: boolean;
  /** true if trace.jsonl was found (else only the workflow file rendered) */
  hasTrace: boolean;
  /** true if analysis.jsonl was found (else trace-only render) */
  hasAnalysis: boolean;
  /** non-fatal note for the user (e.g. "Analysis not available yet") */
  notice?: string;
  /** fatal error if all three loads failed (process unresolved, etc) */
  error?: string;
}
