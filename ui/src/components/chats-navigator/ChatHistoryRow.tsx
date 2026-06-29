import { AgenticProcess, TypeId } from '@sdk';
import { useMemo } from 'react';
import { cn, RAIL_DIM_WHEN_CLOSED } from '@src/lib/utils';
import { List, Loader2, MessageSquare, Star, Trash2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import {
  WorkerIcon,
  pickHistoryTitle,
  timeAgo,
} from '@src/components/entity-execution-panel/history-row';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useIsBurning } from '@src/store/pending-actions-store';
import { ChatPromptsPopover } from './ChatPromptsPopover';

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
  /** True when this chat's process backs an open tab → stays bright (vs. dimmed). */
  hasOpenTab: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

export function ChatHistoryRow({ entry, selected, hasOpenTab, onSelect, onToggleFavorite, onDelete }: ChatHistoryRowProps) {
  const { t } = useLingui();
  // Subscribe to the backing process so a rename (tab/process) re-renders this
  // row instead of leaving a stale title. Gate `enabled` on a cached hit so we
  // only watch already-materialized processes (open-tab sessions) — never fire a
  // fetch per history row for on-disk-only sessions. `useEntity` returns the
  // cached instance and subscribes to its data-ops without an extra API call.
  const cached = entry.agentic_process_id
    ? AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id) ?? null
    : null;
  const typeId = useMemo(
    () => (entry.agentic_process_id ? new TypeId(AgenticProcess.type, entry.agentic_process_id) : null),
    [entry.agentic_process_id],
  );
  const { data: watched } = useEntity<AgenticProcess>(typeId, { enabled: !!cached });
  const process = watched ?? cached;
  const title = pickHistoryTitle(process, entry);
  // Live "this chat is working" signal — true while its worker is mid-turn.
  const busy = useIsBurning(entry.agentic_process_id);
  // Project · branch survive only as a hover tooltip on the row (no visible subline).
  const meta = [entry.project_name, entry.git_branch].filter(Boolean).join(' · ');
  const hasMsgs = !!entry.message_count && entry.message_count > 0;
  // Total transcript turns (user + assistant), not prompts — labelled plainly so the
  // count doesn't read as a prompt count.
  const msgCountLabel = entry.message_count === 1 ? t`1 message` : t`${entry.message_count} messages`;
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
        'group cursor-pointer border-b px-3 py-2 text-xs outline-none transition-[color,background-color,border-color,opacity] hover:bg-muted/50 focus-visible:bg-muted/50',
        selected && 'bg-muted',
        // Dim chats with no open tab (and not the active row); hover restores.
        !selected && !hasOpenTab && RAIL_DIM_WHEN_CLOSED,
      )}
      data-testid="chat-history-row"
      title={meta || undefined}
    >
      <div className="flex items-center gap-1.5">
        {/* Leftmost status gutter — fills with a spinner only while this chat's
            worker is actively doing work; reserved so rows stay aligned. */}
        <span
          className="flex h-3 w-3 shrink-0 items-center justify-center"
          title={busy ? t`Working…` : undefined}
          aria-label={busy ? t`Working` : undefined}
          data-testid="chat-history-row-busy"
          data-busy={busy ? 'true' : 'false'}
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />}
        </span>
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
            title={fav ? t`Unstar` : t`Star`}
            aria-label={fav ? t`Unstar chat` : t`Star chat`}
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
            title={t`Delete chat`}
            aria-label={t`Delete chat`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
        {/* Trailing cluster: a non-interactive message-count INFO LABEL (the
            number is total transcript messages, not prompts), plus a distinct
            "review prompts" ACTION button. The action uses opacity (not display)
            for its hover reveal so its popover stays anchored once opened even as
            the row loses hover. */}
        {hasMsgs && (
          <span className="flex shrink-0 items-center gap-1">
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
              title={msgCountLabel}
              aria-label={msgCountLabel}
              data-testid="chat-history-row-msgcount"
            >
              <MessageSquare className="h-2.5 w-2.5" />
              {entry.message_count}
            </span>
            <ChatPromptsPopover entry={entry}>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                title={t`Review prompts`}
                aria-label={t`Review prompts`}
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                data-testid="chat-history-row-prompts"
              >
                <List className="h-3 w-3" />
              </button>
            </ChatPromptsPopover>
          </span>
        )}
      </div>
    </div>
  );
}
