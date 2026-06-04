import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { AlertTriangle } from 'lucide-react';

import type { AnchoredItem, AnchoredTrack } from '../types';

export type IssueSeverity = 'info' | 'warn' | 'error';

export interface IssueMark {
  kind: string;
  note: string;
  severity: IssueSeverity;
}

export const ISSUE_TRACK_WIDTH = 96;

/** @deprecated Use buildMarkerTrack from '../tracks/MarkerTrack' with kind: 'issue' items. */
export function buildIssueTrack(items: AnchoredItem<IssueMark>[]): AnchoredTrack<IssueMark> {
  return {
    id: 'issues',
    side: 'right',
    width: ISSUE_TRACK_WIDTH,
    items,
    renderItem: (item) => <IssueChip issue={item.data} />,
  };
}

export function IssueChip({ issue }: { issue: IssueMark }) {
  const tone =
    issue.severity === 'error'
      ? 'bg-destructive/10 text-destructive border-destructive/30'
      : issue.severity === 'warn'
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
        : 'bg-muted text-muted-foreground border-border';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium', tone)}>
          <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{issue.kind}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px]">
        <div className="font-medium">{issue.kind}</div>
        {issue.note && <div className="mt-0.5 whitespace-pre-wrap text-[10px] opacity-80">{issue.note}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
