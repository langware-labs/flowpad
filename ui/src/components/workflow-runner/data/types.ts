/**
 * Canonical data shapes for the workflow-runner view.
 *
 * Consolidates ui/src/components/workflow-trace/types.ts. Adds `severity`
 * (SeverityTier — single source of truth) and run-overlay structures.
 *
 * Backend contract: workflow.trace.jsonl is keyed by
 * `flow_sdk/fs_records/workflow_report_entry.py`; workflow.analysis.jsonl by
 * `flow_sdk/fs_records/workflow_analysis_entry.py`. Schema drift = bugs.
 */

import type { SeverityTier } from '@sdk/models/severity';

// ─── Trace event (one JSONL line in workflow.trace.jsonl) ──────────────────

export type TraceStatus = 'enter' | 'done' | 'error' | 'skip' | 'true' | 'false';
export type TraceKind = 'step' | 'condition' | 'call' | 'return';

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

// ─── Analysis record (one JSONL line in workflow.analysis.jsonl) ───────────

export type AnalysisIssueKind =
  | 'incomplete'
  | 'wrong_tool'
  | 'retry'
  | 'mid_run_toolsearch'
  | 'protocol_violation'
  | 'sla_violation'
  | 'sut_regression'
  | 'status_mismatch'
  // Forward-compat: tolerate future kinds.
  | string;

export interface AnalysisIssue {
  /** Free-form kind label from the analyzer. */
  kind?: AnalysisIssueKind;
  /** Some cycles emit `type` instead of `kind`. */
  type?: string;
  /** Free-form severity from the analyzer (error/warn/info or high/medium/low). */
  severity?: string;
  /** Optional category (e.g. behavior, latency, sla_violation). */
  category?: string;
  /** Primary human-readable description (preferred). */
  message?: string;
  /** Alias seen in cycle-4 analyzer output. */
  description?: string;
  /** Legacy alias for message (cycle-1). */
  detail?: string;
  /** Optional numeric anchors used by SLA-style issues. */
  threshold_ms?: number;
  actual_ms?: number;
}

export interface AnalysisToolCall {
  name: string;
  result_summary?: string;
}

export type AnalyzedStatus = 'done' | 'error' | 'skip' | 'incomplete';

export interface AnalysisRecord {
  anchor: { file: string; line: number };
  /** Both names seen in the wild — analyzer skill builds aliased it. */
  step_text?: string;
  step?: string;
  trace?: {
    enter_ts?: string;
    done_ts?: string;
    duration_ms?: number;
    status?: AnalyzedStatus;
    detail?: string | null;
  };
  transcript_span?: {
    start_uuid?: string;
    end_uuid?: string;
    tool_calls?: AnalysisToolCall[];
  };
  issues?: AnalysisIssue[];
  /** Legacy singular form (cycle-1 analyzer). */
  issue?: string | AnalysisIssue;
  recommendation?: string | null;
  /** Record-level severity hint (cycle-1 + cycle-4 analyzers both used this). */
  severity?: string;
  /** Analyzer-specific bag (e.g. run_history_ms). */
  [extra: string]: unknown;
}

// ─── Normalized (post-reducer) view-models ──────────────────────────────────

/** One issue after severity tier classification. */
export interface NormalizedIssue {
  tier: SeverityTier;
  /** Primary description text. */
  message: string;
  /** Original kind label, for hover/expert display. */
  kind?: string;
  category?: string;
  /** Original severity string, retained for tooltip. */
  rawSeverity?: string;
  threshold_ms?: number;
  actual_ms?: number;
}

/** One step after merging trace + analysis. */
export interface StepViewModel {
  file: string;
  line: number;
  step_text: string;
  status: AnalyzedStatus;
  duration_ms?: number;
  detail?: string;
  tool_calls?: AnalysisToolCall[];
  issues: NormalizedIssue[];
  recommendation?: string;
  cost_usd?: number;
  /** Worst tier among issues — used for the gutter chip color. */
  worstTier?: SeverityTier;
}

/** Aggregate counts across a run's steps. */
export interface RunSummary {
  cleanCount: number;
  warnCount: number;
  errorCount: number;
  pendingCount: number;
  totalDurationMs: number;
  totalCostUsd?: number;
  total: number;
}

// ─── Run / per-run grouping ─────────────────────────────────────────────────

/** One run's full processed dataset. */
export interface RunViewModel {
  processId: string;
  /** Stable color index for overlay (0..N-1). */
  colorIndex: number;
  /** Display label for the run-strip chip (e.g. "#3 · 13:35"). */
  label: string;
  /** Process status from the entity. */
  rawStatus?: string;
  /** Workflow-level pass/fail verdict derived from step statuses. */
  verdict: 'pass' | 'fail' | 'partial' | 'unknown';
  /** When the runner started, ISO 8601 — from process.created_date. */
  startedAt?: string;
  /** Wall-clock duration in seconds (last trace event ts − first), or null. */
  durationSec?: number;
  /** USD cost — from AgenticProcess.total_cost_usd. */
  costUsd?: number;
  steps: StepViewModel[];
  summary: RunSummary;
  hasTrace: boolean;
  hasAnalysis: boolean;
}

/** A step's history slice across N runs — fuel for the sparkline. */
export interface StepHistoryPoint {
  processId: string;
  colorIndex: number;
  status: AnalyzedStatus;
  duration_ms?: number;
  cost_usd?: number;
  worstTier?: SeverityTier;
}

export interface StepHistory {
  /** 1-indexed line in the workflow file. */
  line: number;
  step_text: string;
  /** One point per run, newest-first. */
  points: StepHistoryPoint[];
}

// ─── Attention banner ───────────────────────────────────────────────────────

/** One row in the top "Needs Attention" banner. */
export interface AttentionItem {
  /** Stable id for dismissal tracking (session-storage). */
  id: string;
  tier: SeverityTier;
  /** One-line summary the banner displays. */
  headline: string;
  /** Optional longer explanation rendered when expanded. */
  detail?: string;
  /** Anchor the banner can scroll to / select. */
  anchor?: { line: number; processId?: string };
  /** Pattern that triggered the banner (e.g. "persists across 3 runs"). */
  reason?: string;
}

// ─── Learning artifacts (memory / past attempts / feedback) ─────────────────

export interface MemoryArtifact {
  content: string;
  bytes: number;
}

export interface FeedbackArtifact {
  content: string;
  mtime: number;
}

export interface LearningLogEntry {
  /** Heading text (timestamp from `## ...` line). */
  heading: string;
  /** Body markdown between this `## ` and the next. */
  body: string;
  /** Sometimes present in our log: "Attempt: #N" — null if unparseable. */
  attemptNumber?: number;
  /** Sometimes present: `- Process: <uuid>` — null if absent. */
  processId?: string;
  /** First "Issue: ..." line from the body, when present. */
  issue?: string;
  /** First "Fix: ..." line from the body, when present. */
  fix?: string;
}

export interface LearningLogArtifact {
  content: string;
  entries: LearningLogEntry[];
}

export interface HistoryEntry {
  timestamp: string;
  display: string;
  archiveDir: string;
  cleanSteps: number;
  totalSteps: number;
  totalIssues: number;
  hasError: boolean;
  isCurrent: boolean;
}

export interface LearningArtifacts {
  workflowDataDir?: string;
  memory?: MemoryArtifact;
  feedback?: FeedbackArtifact;
  learningLog?: LearningLogArtifact;
  history: HistoryEntry[];
  isLoading: boolean;
}

// ─── Top-level view-model the WorkflowRunnerView consumes ───────────────────

export interface WorkflowRunnerViewModel {
  workflowFile: string;
  /** Raw markdown content of the workflow file. */
  fullText: string;
  /** Markdown before the `## Steps` heading (titles, description, etc). */
  header: string;
  /** All available runs, newest-first. */
  runs: RunViewModel[];
  /** History across runs, keyed by step line. */
  stepHistory: Map<number, StepHistory>;
  /** Workflow-level artifacts (memory.md, learning.log.md, feedback.md). */
  learning: LearningArtifacts;
  /** Items the AttentionBanner should display. */
  attentions: AttentionItem[];
  isLoading: boolean;
  notice?: string;
  error?: string;
}

// ─── View mode + selection state ────────────────────────────────────────────

export type ViewMode = 'simple' | 'expert';
