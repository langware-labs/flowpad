/**
 * Top strip: workflow title · active-run verdict · trend · cost · time.
 * Replaces workflow-trace/RunSummaryBanner.tsx.
 *
 * Pure render — receives the workflow + active RunViewModel + viewMode.
 */

import { Workflow } from '@sdk';
import { cn } from '@src/lib/utils';
import { Check, MinusCircle, X } from 'lucide-react';

import type { RunViewModel, ViewMode } from '../data/types';
import { ViewModeToggle } from './ViewModeToggle';

interface RunSummaryStripProps {
  workflow: Workflow;
  activeRun?: RunViewModel;
  /** Total runs in history — independent of which are loaded into vm. */
  totalRunCount: number;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
}

const VERDICT_ICON = {
  pass: Check,
  fail: X,
  partial: MinusCircle,
  unknown: MinusCircle,
} as const;

const VERDICT_COLOR = {
  pass: 'text-emerald-500',
  fail: 'text-destructive',
  partial: 'text-amber-500',
  unknown: 'text-muted-foreground',
} as const;

function fmtDuration(sec?: number): string | null {
  if (sec === undefined || sec === null || sec <= 0) return null;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${s}s`;
}

function fmtCost(usd?: number): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  return `$${usd.toFixed(2)}`;
}

export function RunSummaryStrip({
  workflow,
  activeRun,
  totalRunCount,
  viewMode,
  onViewModeChange,
}: RunSummaryStripProps) {
  const Icon = activeRun ? VERDICT_ICON[activeRun.verdict] : MinusCircle;
  const color = activeRun ? VERDICT_COLOR[activeRun.verdict] : VERDICT_COLOR.unknown;
  const duration = activeRun ? fmtDuration(activeRun.durationSec) : null;
  const cost = activeRun ? fmtCost(activeRun.costUsd) : null;
  const passedSteps = activeRun
    ? activeRun.summary.total - activeRun.summary.errorCount - activeRun.summary.pendingCount
    : 0;

  return (
    <div
      data-testid="run-summary-strip"
      className="flex items-center gap-3 border-b bg-background px-4 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 truncate">
          <h2 className="truncate text-sm font-semibold">{workflow.name ?? workflow.id}</h2>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {totalRunCount} run{totalRunCount === 1 ? '' : 's'}
          </span>
        </div>
        {activeRun && (
          <div className="mt-0.5 flex items-baseline gap-2 text-xs tabular-nums">
            <Icon className={cn('h-3 w-3', color)} />
            <span className={cn('font-medium uppercase', color)}>{activeRun.verdict}</span>
            {activeRun.summary.total > 0 && (
              <span className="text-muted-foreground">
                {passedSteps}/{activeRun.summary.total} steps
              </span>
            )}
            {duration && <span className="text-muted-foreground">· {duration}</span>}
            {cost && <span className="text-muted-foreground">· {cost}</span>}
          </div>
        )}
      </div>
      <ViewModeToggle viewMode={viewMode} onChange={onViewModeChange} />
    </div>
  );
}
