import { AgenticProcess, TypeId, WorkerStatus } from '@sdk';
import { useMemo, type ComponentType } from 'react';
import { cn, RAIL_DIM_WHEN_CLOSED } from '@src/lib/utils';
import { Check, List, Loader2, MessageSquare, Star, Trash2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { WorkerIcon, pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useIsBurning, useWorkerStatus } from '@src/store/pending-actions-store';
import { compactWorkerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { ChatPromptsPopover } from './ChatPromptsPopover';
import { MatchSnippet, type MatchPart } from './matchSnippet';

/** Absolute last-active stamp for the detailed (search) row — the one-liner
 *  already carries the relative time. */
function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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
  /** Search results: more than the one-liner — project · branch · size, and
   *  where the query matched. */
  detailed?: boolean;
  /** Where the query matched (highlighted), when known. */
  match?: MatchPart[];
  onSelect: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

type RowMark = { icon: ComponentType<{ className?: string }>; cls: string; label: string };

/** The status card behind a row's mark: built only while it is open, with what the row itself does not show —
 *  the CLI's own words for the status and the last prompt. */
function ChatStatusCard({
  mark,
  detail,
  lastPrompt,
}: {
  mark: RowMark;
  detail?: string | null;
  lastPrompt?: string | null;
}) {
  const { t } = useLingui();
  return (
    <>
      <div className="flex items-center gap-1.5 font-medium">
        <mark.icon className={cn('h-3 w-3', mark.cls)} />
        {mark.label}
      </div>
      {detail && <div className="whitespace-pre-wrap break-words">{detail}</div>}
      {lastPrompt && (
        <div className="line-clamp-3 break-words text-muted-foreground">{t`Last message: ${lastPrompt}`}</div>
      )}
    </>
  );
}

export function ChatHistoryRow({
  entry,
  selected,
  hasOpenTab,
  detailed = false,
  match,
  onSelect,
  onToggleFavorite,
  onDelete,
}: ChatHistoryRowProps) {
  const { t } = useLingui();
  // Subscribe to the backing process in the local cache so a rename (tab/process)
  // re-renders this row instead of leaving a stale title. Gate `enabled` on a
  // cached hit so we never fire a fetch per history row for on-disk-only
  // sessions. No backend `watch` here: the list's live query (useChatHistory)
  // already brings every member's changes, and a per-row watch sent one
  // watch/unwatch POST per row each time the navigator mounted — ~40 per
  // process <-> doc switch.
  const cached = entry.agentic_process_id
    ? (AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id) ?? null)
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
  // Live tracker first; a non-live chat falls back to its cached process.
  const liveStatus = useWorkerStatus(entry.agentic_process_id);
  // A past session with no live tracker and no process has no worker: it is inactive.
  const workerStatus = liveStatus ?? (process ? process.workerStatus : WorkerStatus.INACTIVE);
  // Every busy state draws one spinner; the tooltip names the actual status.
  // A met /goal → green check; else the worker status's own mark (Unknown when none is known).
  const cfg = compactWorkerStatusConfig(workerStatus);
  const mark =
    busy || cfg.animate
      ? {
          key: 'busy',
          icon: Loader2,
          cls: 'animate-spin text-emerald-500',
          label: cfg.animate ? cfg.label : t`Working…`,
        }
      : process?.goal_met
        ? { key: 'goal_met', icon: Check, cls: 'text-emerald-500', label: t`Goal completed` }
        : { key: workerStatus ?? WorkerStatus.UNKNOWN, icon: cfg.icon, cls: cfg.color, label: cfg.label };
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
        // Search results are never dimmed — they are what was asked for.
        !selected && !hasOpenTab && !detailed && RAIL_DIM_WHEN_CLOSED,
      )}
      data-testid="chat-history-row"
      data-process-id={entry.agentic_process_id ?? undefined}
      data-worker-session-id={entry.worker_id}
      title={meta || undefined}
    >
      <div className="flex items-center gap-1.5">
        {/* Leftmost status gutter — spinner while working, green check for a met /goal, else the worker
            status's mark; reserved so rows stay aligned. Hovering it opens the status card (the tab card's delay). */}
        {/* Its own provider: the row also renders outside the app's root provider (lists, tests). */}
        <TooltipProvider delayDuration={600}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="flex h-3 w-3 shrink-0 items-center justify-center"
                aria-label={mark.label}
                data-testid="chat-history-row-busy"
                data-busy={busy ? 'true' : 'false'}
                data-status={mark.key}
              >
                <mark.icon className={cn('h-3 w-3', mark.cls)} />
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="start"
              className="max-w-72 space-y-1 text-xs"
              data-testid="chat-history-row-status-card"
            >
              <ChatStatusCard mark={mark} detail={process?.worker_status_detail} lastPrompt={entry.last_prompt} />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <WorkerIcon workerType={entry.worker_type} />
        <span
          className={cn(
            'min-w-0 flex-1 font-medium text-foreground',
            detailed ? 'line-clamp-2 break-words' : 'truncate',
          )}
        >
          {title}
        </span>
        {/* Default: favorite marker + time-ago; swapped for the actions on hover. */}
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground group-hover:hidden">
          {fav && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
          {formatTimeAgoShort(entry.last_active_time)}
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
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                data-testid="chat-history-row-prompts"
              >
                <List className="h-3 w-3" />
              </button>
            </ChatPromptsPopover>
          </span>
        )}
      </div>
      {detailed && (
        <div className="ms-[18px] mt-0.5 flex min-w-0 flex-col gap-0.5 ps-3.5 text-[10px] text-muted-foreground">
          <span className="truncate" data-testid="chat-history-row-meta">
            {[entry.project_name, entry.git_branch, hasMsgs ? msgCountLabel : null, formatWhen(entry.last_active_time)]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {match && (
            <span className="line-clamp-2 break-words text-[11px] leading-snug">
              <MatchSnippet parts={match} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
