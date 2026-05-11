import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { CheckCircle2, MinusCircle, RotateCw, XCircle } from 'lucide-react';

import type { AnchoredItem, AnchoredTrack } from '../types';

export type TraceMarkStatus = 'done' | 'retried' | 'error' | 'skip';

export interface TraceMark {
  status: TraceMarkStatus;
  /** Total duration in ms across enter→done cycles, including retries. */
  durationMs: number;
  /** Attempt count (>1 implies retried). */
  attempts: number;
  /** Optional error message body for status==='error'. */
  errorMessage?: string;
  /** ISO timestamps of the first enter and final done/error. */
  startedAt?: string;
  endedAt?: string;
}

export const TRACE_TRACK_WIDTH = 84;

export function buildTraceTrack(items: AnchoredItem<TraceMark>[]): AnchoredTrack<TraceMark> {
  return {
    id: 'trace',
    side: 'left',
    width: TRACE_TRACK_WIDTH,
    items,
    renderItem: (item) => <TraceMarker mark={item.data} />,
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function TraceMarker({ mark }: { mark: TraceMark }) {
  const { Icon, color } = iconFor(mark);
  const main = `${fmtDuration(mark.durationMs)}`;
  const retried = mark.attempts > 1 ? ` ×${mark.attempts}` : '';
  const tooltip = (
    <div className="space-y-0.5">
      <div className="font-medium">
        {mark.status}
        {retried && ` · ${mark.attempts} attempts`}
      </div>
      <div className="text-[10px] opacity-80">
        {fmtDuration(mark.durationMs)}
        {mark.startedAt && ` · started ${new Date(mark.startedAt).toLocaleTimeString()}`}
      </div>
      {mark.errorMessage && (
        <div className="mt-1 max-w-[280px] whitespace-pre-wrap text-[10px] text-amber-200">
          {mark.errorMessage}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-full items-start justify-end gap-1 px-1.5 pt-1 text-[10px] tabular-nums text-muted-foreground">
          <Icon className={cn('h-3 w-3 shrink-0', color)} />
          <span className="truncate">{main}{retried}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function iconFor(mark: TraceMark) {
  if (mark.status === 'error') return { Icon: XCircle, color: 'text-destructive' };
  if (mark.status === 'retried') return { Icon: RotateCw, color: 'text-amber-500' };
  if (mark.status === 'skip') return { Icon: MinusCircle, color: 'text-muted-foreground/60' };
  return { Icon: CheckCircle2, color: 'text-emerald-500' };
}
