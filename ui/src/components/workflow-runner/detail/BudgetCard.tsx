/**
 * Mini-card showing actual vs budget for a step that flagged an SLA issue.
 *
 * Pure render: receives `actualMs`, `thresholdMs`, and derives the display.
 * Only renders when both numbers are present and actual > 0.
 */

import { cn } from '@src/lib/utils';
import { TrendingDown, TrendingUp } from 'lucide-react';

interface BudgetCardProps {
  actualMs?: number;
  thresholdMs?: number;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function BudgetCard({ actualMs, thresholdMs }: BudgetCardProps) {
  if (
    typeof actualMs !== 'number' ||
    typeof thresholdMs !== 'number' ||
    actualMs <= 0 ||
    thresholdMs <= 0
  ) {
    return null;
  }
  const over = actualMs > thresholdMs;
  const excess = actualMs - thresholdMs;
  return (
    <div
      data-testid="budget-card"
      className={cn(
        'rounded-md border p-3 text-xs',
        over
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-emerald-500/30 bg-emerald-500/5',
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 font-medium">
        {over ? (
          <TrendingUp className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />
        )}
        <span>{over ? 'Over budget' : 'Within budget'}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Budget</dt>
        <dd>{fmtMs(thresholdMs)}</dd>
        <dt className="text-muted-foreground">Actual</dt>
        <dd>{fmtMs(actualMs)}</dd>
        <dt className="text-muted-foreground">{over ? 'Excess' : 'Headroom'}</dt>
        <dd className={over ? 'text-destructive' : 'text-emerald-500'}>
          {over ? '+' : '−'}
          {fmtMs(Math.abs(excess))}
        </dd>
      </dl>
    </div>
  );
}
