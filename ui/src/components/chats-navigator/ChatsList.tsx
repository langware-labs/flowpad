import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import type { ChatBucket } from './useChatHistory';
import { Trans } from '@lingui/react/macro';
import { ChatHistoryRow } from './ChatHistoryRow';
import type { MatchPart } from './matchSnippet';

/**
 * The Chats navigator's customBody: a time-bucketed list of chat rows. The
 * filter controls (search + scope + worker/favorites) live in the navigator
 * HEADER (like every other side menu), not here. Selection stays URL-first —
 * rows call back up to the navigator.
 */
interface ChatsListProps {
  buckets: ChatBucket[];
  isLoading: boolean;
  /** Quick search is active → one flat, latest-first list (no bucket headers). */
  searching?: boolean;
  /** Search only: where each row matched (worker_id → highlighted parts). */
  matches?: Map<string, MatchPart[]>;
  /** The session-content search is still in flight → say so, don't claim "no match". */
  isSearchingContent?: boolean;
  /** Active process id (from the URL/context) → highlighted row. */
  activeProcessId: string | null;
  /** Process ids that back an open tab → bright; others dim until hovered. */
  openProcessIds: Set<string>;
  onSelect: (entry: WorkerHistoryEntry) => void;
  onToggleFavorite: (entry: WorkerHistoryEntry) => void;
  onDelete: (entry: WorkerHistoryEntry) => void;
}

export function ChatsList({
  buckets,
  isLoading,
  searching = false,
  matches,
  isSearchingContent = false,
  activeProcessId,
  openProcessIds,
  onSelect,
  onToggleFavorite,
  onDelete,
}: ChatsListProps) {
  const empty = buckets.length === 0;
  // Buckets are already recency-sorted, so flattening keeps latest on top.
  const groups: ChatBucket[] = searching ? [{ label: '', entries: buckets.flatMap((b) => b.entries) }] : buckets;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && empty ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            <Trans>Loading chats…</Trans>
          </div>
        ) : empty && isSearchingContent ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            <Trans>Searching inside sessions…</Trans>
          </div>
        ) : empty && searching ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            <Trans>No matching sessions</Trans>
          </div>
        ) : empty ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            <Trans>No chats yet</Trans>
          </div>
        ) : (
          groups.map((bucket) => (
            <div key={bucket.label || 'results'}>
              {bucket.label && (
                <div className="sticky top-0 z-10 bg-background/95 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
                  {bucket.label}
                </div>
              )}
              {bucket.entries.map((entry) => (
                <ChatHistoryRow
                  key={entry.agentic_process_id ?? entry.worker_id}
                  entry={entry}
                  selected={!!activeProcessId && entry.agentic_process_id === activeProcessId}
                  detailed={searching}
                  match={matches?.get(entry.worker_id)}
                  hasOpenTab={!!entry.agentic_process_id && openProcessIds.has(entry.agentic_process_id)}
                  onSelect={() => onSelect(entry)}
                  onToggleFavorite={() => onToggleFavorite(entry)}
                  onDelete={() => onDelete(entry)}
                />
              ))}
            </div>
          ))
        )}
        {!empty && isSearchingContent && (
          <div className="px-3 py-2 text-center text-[10px] text-muted-foreground">
            <Trans>Searching inside sessions…</Trans>
          </div>
        )}
      </div>
    </div>
  );
}
