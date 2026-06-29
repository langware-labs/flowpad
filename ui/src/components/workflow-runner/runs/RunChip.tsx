/**
 * One run in the bottom RunStrip — minimal: time + pass/fail icon, with the
 * border itself carrying the verdict color (green=pass, red=fail).
 *
 * Pure render. Cost / duration / step counts live in the tooltip.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { Check, MinusCircle, X } from 'lucide-react';

import type { RunViewModel } from '../data/types';

interface RunChipProps {
  run: RunViewModel;
  isActive: boolean;
  isOverlay: boolean;
  onSelect: (e: React.MouseEvent) => void;
}

const VERDICT_ICON = {
  pass: Check,
  fail: X,
  partial: MinusCircle,
  unknown: MinusCircle,
} as const;

const VERDICT_BORDER = {
  pass: 'border-emerald-500/70',
  fail: 'border-destructive/70',
  partial: 'border-amber-500/70',
  unknown: 'border-border',
} as const;

const VERDICT_ICON_COLOR = {
  pass: 'text-emerald-500',
  fail: 'text-destructive',
  partial: 'text-amber-500',
  unknown: 'text-muted-foreground',
} as const;

function fmtTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtCost(usd?: number): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  return `$${usd.toFixed(2)}`;
}

function fmtDuration(sec?: number): string | null {
  if (sec === undefined || sec === null || sec <= 0) return null;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${s}s`;
}

export function RunChip({ run, isActive, isOverlay, onSelect }: RunChipProps) {
  const Icon = VERDICT_ICON[run.verdict] ?? MinusCircle;
  const borderClass = VERDICT_BORDER[run.verdict] ?? VERDICT_BORDER.unknown;
  const iconColor = VERDICT_ICON_COLOR[run.verdict] ?? VERDICT_ICON_COLOR.unknown;
  const time = fmtTime(run.startedAt) ?? run.label;
  const cost = fmtCost(run.costUsd);
  const duration = fmtDuration(run.durationSec);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="run-chip"
          data-process-id={run.processId}
          data-verdict={run.verdict}
          data-active={isActive ? 'true' : 'false'}
          data-overlay={isOverlay ? 'true' : 'false'}
          onClick={onSelect}
          className={cn(
            'flex w-full items-center justify-center gap-1 rounded-md border bg-background px-1.5 py-1 text-[11px] tabular-nums shadow-sm transition-all',
            borderClass,
            isActive
              ? 'bg-primary/10 ring-2 ring-primary/40'
              : isOverlay
                ? 'bg-muted/40'
                : 'hover:bg-muted/40 hover:shadow',
          )}
        >
          <Icon className={cn('h-3 w-3', iconColor)} />
          <span className="font-medium">{time}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px]">
        <div className="font-medium">{run.verdict.toUpperCase()}</div>
        <div className="mt-0.5 text-[10px] opacity-80">
          {run.summary.cleanCount + run.summary.warnCount}/{run.summary.total} steps passed
          {run.summary.errorCount > 0 && ` · ${run.summary.errorCount} errored`}
        </div>
        {(duration || cost) && (
          <div className="mt-0.5 text-[10px] tabular-nums opacity-70">
            {duration && `${duration}`}
            {duration && cost && ' · '}
            {cost && `${cost}`}
          </div>
        )}
        <div className="mt-1 text-[10px] opacity-60">
          Click to make active · Shift-click to overlay
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
