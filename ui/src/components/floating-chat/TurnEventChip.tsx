import { FlowData } from '@sdk';
import { Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { pairToolEvents } from './groupTurnEvents';
import { TurnEventList } from './ToolEntryRow';

interface TurnEventChipProps {
  /** The CURRENT turn's dense events (tool calls, reasoning, status, errors). */
  events: FlowData[];
}

/**
 * Compact live event counter for the current turn: a tiny pill whose number
 * climbs as the agent emits flow data (tool calls, reasoning, status, errors).
 * Clicking it opens a popover with the full per-event list — the SAME list the
 * inline {@link ToolEntryRow} expands to (`TurnEventList`). Renders nothing
 * until the turn has produced at least one dense event, so an idle/thinking
 * turn shows just the dots + clock. Meant to sit in the chat activity footer.
 */
export function TurnEventChip({ events }: TurnEventChipProps) {
  const { total } = useMemo(() => pairToolEvents(events), [events]);
  if (total === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="turn-event-chip"
          title={`${total} event${total === 1 ? '' : 's'} this turn`}
          className={[
            'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5',
            'text-[11px] leading-none text-muted-foreground',
            'bg-muted/40 transition-colors hover:bg-muted hover:text-foreground',
          ].join(' ')}
        >
          <Wrench className="h-3 w-3 animate-pulse" />
          <span className="tabular-nums">{total}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-80 w-80 overflow-y-auto p-1"
        data-testid="turn-event-chip-list"
      >
        <TurnEventList events={events} />
      </PopoverContent>
    </Popover>
  );
}
