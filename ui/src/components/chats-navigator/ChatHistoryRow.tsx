import { AgenticProcess } from '@sdk';
import { cn } from '@src/lib/utils';
import { Star, Trash2 } from 'lucide-react';
import {
  WorkerIcon,
  buildHistorySubline,
  pickHistoryTitle,
  timeAgo,
} from '@src/components/entity-execution-panel/history-row';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';

/**
 * One chat-history row in the Chats navigator. Pure presentation over the
 * shared `history-row` formatters (worker glyph, title, subline, time-ago) so it
 * stays consistent with the terminal HistoryModal + the chat dropdown. Click
 * selects (URL-first, owned by the parent); star/trash are per-row side effects
 * revealed on hover.
 */
interface ChatHistoryRowProps {
  entry: WorkerHistoryEntry;
  selected: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

export function ChatHistoryRow({ entry, selected, onSelect, onToggleFavorite, onDelete }: ChatHistoryRowProps) {
  const process = entry.agentic_process_id
    ? AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id) ?? null
    : null;
  const title = pickHistoryTitle(process, entry);
  const subline = buildHistorySubline(entry);
  const fav = process?.favorite_index != null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group flex cursor-pointer flex-col gap-0.5 border-b px-3 py-2 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50',
        selected && 'bg-muted',
      )}
      data-testid="chat-history-row"
    >
      <div className="flex items-center gap-1.5">
        <WorkerIcon workerType={entry.worker_type} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        {/* Default: favorite marker + time-ago; swapped for the actions on hover. */}
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground group-hover:hidden">
          {fav && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
          {timeAgo(entry.last_active_time)}
        </span>
        <div className="hidden shrink-0 items-center gap-1 group-hover:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            title={fav ? 'Unstar' : 'Star'}
            aria-label={fav ? 'Unstar chat' : 'Star chat'}
            className="text-muted-foreground hover:text-amber-500"
          >
            <Star className={cn('h-3 w-3', fav && 'fill-amber-400 text-amber-400')} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete chat"
            aria-label="Delete chat"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      {subline && <span className="truncate pl-[1.125rem] text-[11px] text-muted-foreground">{subline}</span>}
    </div>
  );
}
