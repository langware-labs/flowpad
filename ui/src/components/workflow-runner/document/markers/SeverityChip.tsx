import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { SeverityTier } from '@sdk/models/severity';

import type { NormalizedIssue } from '../../data/types';

/**
 * Chip that renders one normalized issue in the right gutter or in expert
 * mode's RawIssuesList. Color + icon are derived purely from `issue.tier`.
 * No business logic — render only.
 */

interface SeverityChipProps {
  issue: NormalizedIssue;
}

const TONE: Record<SeverityTier, string> = {
  [SeverityTier.ATTENTION]:
    'bg-destructive/10 text-destructive border-destructive/30',
  [SeverityTier.NOTABLE]:
    'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  [SeverityTier.INFO]:
    'bg-muted text-muted-foreground border-border',
};

const ICON: Record<SeverityTier, typeof AlertTriangle> = {
  [SeverityTier.ATTENTION]: AlertOctagon,
  [SeverityTier.NOTABLE]: AlertTriangle,
  [SeverityTier.INFO]: Info,
};

function humanize(raw: string): string {
  // snake/kebab → Sentence case. Analyzer emits identifiers like
  // `sla_violation` or `mid_run_toolsearch`; viewers want "Sla violation".
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(\w)/, (c) => c.toUpperCase());
}

export function SeverityChip({ issue }: SeverityChipProps) {
  const Icon = ICON[issue.tier];
  const rawLabel = issue.kind || issue.category || issue.tier;
  const label = humanize(rawLabel);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-testid="severity-chip"
          data-tier={issue.tier}
          className={cn(
            'flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium leading-tight',
            TONE[issue.tier],
          )}
        >
          <Icon className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[320px]">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 whitespace-pre-wrap text-[10px] opacity-80">
          {issue.message}
        </div>
        {(issue.threshold_ms || issue.actual_ms) && (
          <div className="mt-1 text-[10px] tabular-nums opacity-70">
            {issue.threshold_ms && `budget ${issue.threshold_ms}ms`}
            {issue.actual_ms && ` · actual ${issue.actual_ms}ms`}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
