/**
 * Combine a workflow's step bullets + a run's trace summary + a run's
 * analysis-by-line into one StepViewModel[] keyed by line.
 *
 * The workflow .md is authoritative for the step list (line + text). Trace
 * and analysis attach to those lines; an analysis record for a line that
 * isn't a step bullet is dropped (with a console.warn in dev).
 */

import { SeverityTier } from '@sdk/models/severity';

import type {
  AnalyzedStatus,
  RunSummary,
  StepViewModel,
} from '../../data/types';
import type { AnalysisByLine } from './reduceAnalysis';
import { extractSteps } from './extractStepLines';
import type { TraceSummary } from './reduceTrace';
import { buildLineRemap } from './remapAnchors';

function pickStatus(trace?: TraceSummary): AnalyzedStatus {
  if (!trace) return 'incomplete';
  if (trace.status === 'error') return 'error';
  if (trace.status === 'skip') return 'skip';
  return 'done';
}

export function mergeSteps(
  source: string,
  trace: TraceSummary[],
  analysis: AnalysisByLine[],
): StepViewModel[] {
  const stepDefs = extractSteps(source);

  // Pre-linter trace + analysis line numbers may not match current bullet
  // lines (the user's markdown linter inserts blank lines between bullets,
  // shifting step lines). Remap by ordinal so old data still attaches.
  const bulletLines = stepDefs.map((s) => s.line);
  const anchorLines = Array.from(
    new Set([...trace.map((t) => t.line), ...analysis.map((a) => a.line)]),
  );
  const remap = buildLineRemap({ bulletLines, anchorLines });

  const traceByLine = new Map<number, TraceSummary>();
  for (const t of trace) traceByLine.set(remap(t.line), t);
  const analysisByLine = new Map<number, AnalysisByLine>();
  for (const a of analysis) analysisByLine.set(remap(a.line), a);

  return stepDefs.map(({ line, text }) => {
    const t = traceByLine.get(line);
    const a = analysisByLine.get(line);
    const issues = a?.issues ?? [];
    return {
      file: '',
      line,
      step_text: a?.step_text || text,
      status: pickStatus(t),
      duration_ms: t?.durationMs,
      detail: t?.detail,
      tool_calls: undefined, // populated separately when transcript span is available
      issues,
      recommendation: a?.recommendation,
      cost_usd: t?.costUsd,
      worstTier: a?.worstTier,
    } satisfies StepViewModel;
  });
}

export function summarize(steps: StepViewModel[]): RunSummary {
  const summary: RunSummary = {
    cleanCount: 0,
    warnCount: 0,
    errorCount: 0,
    pendingCount: 0,
    totalDurationMs: 0,
    totalCostUsd: undefined,
    total: steps.length,
  };
  let costAcc = 0;
  let costSeen = false;
  for (const s of steps) {
    if (typeof s.duration_ms === 'number') summary.totalDurationMs += s.duration_ms;
    if (typeof s.cost_usd === 'number') {
      costAcc += s.cost_usd;
      costSeen = true;
    }
    if (s.status === 'error') summary.errorCount += 1;
    else if (s.status === 'incomplete' || s.status === 'skip') summary.pendingCount += 1;
    else if (s.worstTier === SeverityTier.ATTENTION) summary.errorCount += 1;
    else if (s.worstTier === SeverityTier.NOTABLE) summary.warnCount += 1;
    else summary.cleanCount += 1;
  }
  if (costSeen) summary.totalCostUsd = costAcc;
  return summary;
}

export function deriveVerdict(summary: RunSummary): 'pass' | 'fail' | 'partial' | 'unknown' {
  if (summary.total === 0) return 'unknown';
  if (summary.errorCount > 0) return 'fail';
  if (summary.pendingCount > 0) return 'partial';
  return 'pass';
}
