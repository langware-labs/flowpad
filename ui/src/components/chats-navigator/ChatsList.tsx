import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import type { ChatBucket } from './useChatHistory';
import { Trans } from '@lingui/react/macro';
import { ChatHistoryRow } from './ChatHistoryRow';

/**
 * The Chats navigator's customBody: a time-bucketed list of chat rows. The
 * filter controls (search + scope + worker/favorites) live in the navigator
 * HEADER (like every other side menu), not here. Selection stays URL-first —
 * rows call back up to the navigator.
 */
interface ChatsListProps {
  buckets: ChatBucket[];
  isLoading: boolean;
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
  activeProcessId,
  openProcessIds,
  onSelect,
  onToggleFavorite,
  onDelete,
}: ChatsListProps) {
  const empty = buckets.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && empty ? (
          <div className="p-4 text-center text-xs text-muted-foreground"><Trans>Loading chats…</Trans></div>
        ) : empty ? (
          <div className="p-4 text-center text-xs text-muted-foreground"><Trans>No chats yet</Trans></div>
        ) : (
          buckets.map((bucket) => (
            <div key={bucket.label}>
              <div className="sticky top-0 z-10 bg-background/95 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
                {bucket.label}
              </div>
              {bucket.entries.map((entry) => (
                <ChatHistoryRow
                  key={entry.agentic_process_id ?? entry.worker_id}
                  entry={entry}
                  selected={!!activeProcessId && entry.agentic_process_id === activeProcessId}
                  hasOpenTab={!!entry.agentic_process_id && openProcessIds.has(entry.agentic_process_id)}
                  onSelect={() => onSelect(entry)}
                  onToggleFavorite={() => onToggleFavorite(entry)}
                  onDelete={() => onDelete(entry)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
