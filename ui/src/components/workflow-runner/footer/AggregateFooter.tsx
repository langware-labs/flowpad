/**
 * Bottom footer: aggregate across all runs (not just selected).
 * Cheap one-liner: N runs · $TOTAL · M min · errors trend.
 *
 * Pure render. Operates on the raw AgenticProcess[] for cost (entity has
 * total_cost_usd) and on RunViewModel[] for verdict/error trend (only the
 * selected runs are loaded; we still surface the count from the entity list).
 */

import type { AgenticProcess } from '@sdk';

import type { RunViewModel } from '../data/types';

interface AggregateFooterProps {
  runs: AgenticProcess[];
  loadedRuns: RunViewModel[];
}

function fmt$(n: number): string {
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

export function AggregateFooter({ runs, loadedRuns }: AggregateFooterProps) {
  const totalCost = runs.reduce((acc, r) => acc + (r.total_cost_usd ?? 0), 0);
  const totalDurationSec = loadedRuns.reduce(
    (acc, r) => acc + (r.durationSec ?? 0),
    0,
  );
  const errorsByRun = loadedRuns.map((r) => r.summary.errorCount);
  const firstErrors = errorsByRun[errorsByRun.length - 1];
  const lastErrors = errorsByRun[0];
  const trend =
    errorsByRun.length >= 2 && firstErrors !== undefined && lastErrors !== undefined
      ? lastErrors < firstErrors
        ? `${firstErrors}→${lastErrors} ↓`
        : lastErrors > firstErrors
          ? `${firstErrors}→${lastErrors} ↑`
          : `${lastErrors} (flat)`
      : null;

  return (
    <div
      data-testid="aggregate-footer"
      className="flex items-center gap-3 border-t bg-background px-4 py-1.5 text-[11px] tabular-nums text-muted-foreground"
    >
      <span>{runs.length} runs</span>
      {totalCost > 0 && <span>· total {fmt$(totalCost)}</span>}
      {totalDurationSec > 0 && (
        <span>
          · {Math.floor(totalDurationSec / 60)}m{Math.floor(totalDurationSec % 60)}s loaded
        </span>
      )}
      {trend && <span>· errors {trend}</span>}
    </div>
  );
}
