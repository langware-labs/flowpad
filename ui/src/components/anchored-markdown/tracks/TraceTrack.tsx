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
  /** USD cost of usage entries whose timestamp falls in [startedAt, endedAt],
   *  resolved via ModelPricing.costOf. Undefined when transcript is missing. */
  costUsd?: number;
}

export const TRACE_TRACK_WIDTH = 112;

/** @deprecated Use buildMarkerTrack from '../tracks/MarkerTrack' with kind: 'trace' items. */
export function buildTraceTrack(items: AnchoredItem<TraceMark>[]): AnchoredTrack<TraceMark> {
  return {
    id: 'trace',
    side: 'left',
    width: TRACE_TRACK_WIDTH,
    items,
    renderItem: (item) => <TraceMarker mark={item.data} />,
  };
}

export { TraceMarker };

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function fmtCost(usd?: number): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function TraceMarker({ mark }: { mark: TraceMark }) {
  const { Icon, color } = iconFor(mark);
  const main = `${fmtDuration(mark.durationMs)}`;
  const retried = mark.attempts > 1 ? ` ×${mark.attempts}` : '';
  const cost = fmtCost(mark.costUsd);
  const tooltip = (
    <div className="space-y-0.5">
      <div className="font-medium">
        {mark.status}
        {retried && ` · ${mark.attempts} attempts`}
      </div>
      <div className="text-[10px] opacity-80">
        {fmtDuration(mark.durationMs)}
        {cost && ` · ${cost}`}
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
          {cost && (
            <span className="ml-0.5 truncate text-muted-foreground/80" data-testid="trace-mark-cost">
              {cost}
            </span>
          )}
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
