import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { CheckCircle2, Clock, MinusCircle, RotateCw, XCircle } from 'lucide-react';

import type { AnalyzedStatus, StepHistory, StepViewModel } from '../../data/types';
import { StepSparkline } from './StepSparkline';

/**
 * Left-gutter marker for one workflow step (one anchor line).
 *
 * Renders: ✓/✗/⏵ icon · duration · cost · this-step's sparkline-across-runs.
 *
 * Pure render: receives `step` (StepViewModel) + `history` (StepHistory) and
 * draws them. No data fetching, no severity classification, no merging.
 */

interface StepStatusMarkerProps {
  step: StepViewModel;
  history?: StepHistory;
  isSelected?: boolean;
  onClick?: () => void;
}

const ICON: Record<AnalyzedStatus, typeof CheckCircle2> = {
  done: CheckCircle2,
  error: XCircle,
  skip: MinusCircle,
  incomplete: Clock,
};

const COLOR: Record<AnalyzedStatus, string> = {
  done: 'text-emerald-500',
  error: 'text-destructive',
  skip: 'text-muted-foreground/60',
  incomplete: 'text-amber-500',
};

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function fmtCost(usd?: number): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function StepStatusMarker({ step, history, isSelected, onClick }: StepStatusMarkerProps) {
  const Icon = ICON[step.status] ?? CheckCircle2;
  const cost = fmtCost(step.cost_usd);
  const stateLabel = step.status;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="step-status-marker"
          data-line={step.line}
          data-status={step.status}
          data-selected={isSelected ? 'true' : 'false'}
          onClick={onClick}
          className={cn(
            'flex h-full w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-[10px] tabular-nums text-muted-foreground transition-colors hover:bg-muted/50',
            isSelected && 'bg-muted ring-1 ring-primary/30',
          )}
        >
          <Icon className={cn('h-3 w-3 shrink-0', COLOR[step.status])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate">{fmtDuration(step.duration_ms)}</span>
              {cost && (
                <span className="truncate text-muted-foreground/80" data-testid="step-cost">
                  {cost}
                </span>
              )}
            </div>
            <div className="mt-0.5">
              <StepSparkline history={history} />
            </div>
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[280px]">
        <div className="font-medium">{stateLabel}</div>
        <div className="mt-0.5 text-[10px] opacity-80">
          {fmtDuration(step.duration_ms)}
          {cost && ` · ${cost}`}
        </div>
        {step.detail && (
          <div className="mt-1 whitespace-pre-wrap text-[10px] opacity-70">{step.detail}</div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// Re-export retry icon if other components want to render it inline.
export { RotateCw };
