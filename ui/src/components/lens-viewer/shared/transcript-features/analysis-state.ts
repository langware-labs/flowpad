import type { AgentTrace, AgenticProcess, WorkerStatus } from '@sdk';
import { isWorkerRunning } from '@sdk';

/** What the transcript toolbar's analysis control should show. */
export type AnalysisAction =
  | { kind: 'run' }
  | { kind: 'analyzing'; process: AgenticProcess }
  | { kind: 'open'; trace: AgentTrace; runCount: number; stale: false }
  | { kind: 'refresh'; trace: AgentTrace; runCount: number; stale: true };

/**
 * Pure derivation of the analysis button state for a session transcript.
 *
 * - no traces, nothing running        → run
 * - an ANALYSIS process is busy       → analyzing (regardless of past traces)
 * - newest trace covers the session   → open (+ rerun secondary)
 * - session has entries newer than it → refresh (+ open secondary)
 *
 * `stale` compares the newest trace's created_date against the transcript's
 * last entry timestamp; either side missing means "not stale".
 */
export function deriveAnalysisAction(args: {
  traces: AgentTrace[];
  analysisProcesses: AgenticProcess[];
  lastEntryTs: string | null;
}): AnalysisAction {
  const { traces, analysisProcesses, lastEntryTs } = args;

  // "Analyzing" = the worker is actively mid-turn (not merely a process row
  // that exists — completed analyses keep their rows as history).
  const running = analysisProcesses.find((p) =>
    isWorkerRunning(p.worker_status as WorkerStatus),
  );
  if (running) return { kind: 'analyzing', process: running };

  if (traces.length === 0) return { kind: 'run' };

  const newest = traces.reduce((best, t) =>
    (createdMs(t) || -Infinity) > (createdMs(best) || -Infinity) ? t : best,
  );

  const traceMs = createdMs(newest);
  const lastMs = lastEntryTs ? Date.parse(lastEntryTs) : NaN;
  const stale = Number.isFinite(traceMs) && Number.isFinite(lastMs) && lastMs > traceMs;

  return stale
    ? { kind: 'refresh', trace: newest, runCount: traces.length, stale: true }
    : { kind: 'open', trace: newest, runCount: traces.length, stale: false };
}

function createdMs(e: { created_date?: string | Date | null }): number {
  const v = e.created_date;
  if (!v) return NaN;
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}
