import type { AgenticProcess } from '@sdk';
import { ListPlus, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useLingui } from '@lingui/react/macro';

/**
 * Left-aligned prompt-queue counter for the chat composer: a tiny pill with a
 * queue icon and the number of prompts waiting to drain. Hidden at zero.
 * Clicking opens the queued entries with a per-entry remove. The backend owns
 * the queue and auto-drains it between turns; this chip is read-and-remove
 * only (`AgenticProcess.dequeue`).
 */
export function QueueChip({ process }: { process: AgenticProcess | null }) {
  const { t } = useLingui();
  const entries = process?.queue?.entries ?? [];
  if (!process || entries.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="entity-execution-queue-chip"
          title={t`Queued messages`}
          className={[
            'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5',
            'text-[11px] leading-none text-muted-foreground',
            'bg-muted/40 transition-colors hover:bg-muted hover:text-foreground',
          ].join(' ')}
        >
          <ListPlus className="h-3 w-3 animate-pulse" />
          <span className="tabular-nums" data-testid="entity-execution-queue-count">
            {entries.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-h-64 w-80 overflow-y-auto p-1"
        data-testid="entity-execution-queue-list"
      >
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted"
            data-testid="entity-execution-queue-entry"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.prompt}</span>
            <button
              type="button"
              aria-label={t`Remove from queue`}
              title={t`Remove from queue`}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              onClick={() => void process.dequeue(entry.id)}
              data-testid="entity-execution-queue-remove"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
