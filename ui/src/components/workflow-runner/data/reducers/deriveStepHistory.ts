/**
 * Derive per-step history across N runs.
 *
 * Used by `StepSparkline` to render this-step-across-runs as a tiny
 * inline graphic, and by `PerRunBreakdown` (expert mode) to render a
 * row-per-run table.
 *
 * Inputs are the full RunViewModel array (sorted newest-first by caller)
 * and the lines we care about (usually `extractStepLines(source)` from
 * the workflow .md).
 */

import type {
  RunViewModel,
  StepHistory,
  StepHistoryPoint,
} from '../../data/types';

export function deriveStepHistory(
  runs: RunViewModel[],
  stepLines: number[],
): Map<number, StepHistory> {
  const out = new Map<number, StepHistory>();
  // Walk oldest-first so the resulting `points` array is chronological
  // (caller can reverse for newest-first display).
  const ordered = [...runs].reverse();
  for (const line of stepLines) {
    const points: StepHistoryPoint[] = [];
    let stepText: string | undefined;
    for (const run of ordered) {
      const step = run.steps.find((s) => s.line === line);
      if (!step) continue;
      if (!stepText && step.step_text) stepText = step.step_text;
      points.push({
        processId: run.processId,
        colorIndex: run.colorIndex,
        status: step.status,
        duration_ms: step.duration_ms,
        cost_usd: step.cost_usd,
        worstTier: step.worstTier,
      });
    }
    out.set(line, {
      line,
      step_text: stepText ?? '',
      points,
    });
  }
  return out;
}
