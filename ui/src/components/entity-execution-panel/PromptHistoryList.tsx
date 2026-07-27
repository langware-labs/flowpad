import { cn } from '@src/lib/utils';
import { History } from 'lucide-react';

/**
 * Compact prompt-history list shown under the composer textarea while the
 * user is arrow-key browsing (and only when there is more than one prompt to
 * browse). Most recent first; the row matching the current browse position is
 * highlighted; clicking a row loads it into the input.
 */
export function PromptHistoryList({
  entries,
  index,
  onPick,
}: {
  /** History entries, oldest first (the hook's natural order). */
  entries: readonly string[];
  /** Current browse position in `entries` (oldest-first indexing). */
  index: number;
  /** Load entry `i` (oldest-first index) into the composer. */
  onPick: (index: number) => void;
}) {
  if (entries.length <= 1) return null;
  // Render newest-first: one ArrowUp = the last prompt = the top row.
  const newestFirst = [...entries].map((text, i) => ({ text, i })).reverse();
  return (
    <div
      className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg border bg-muted/30 p-1"
      data-testid="entity-execution-history-list"
    >
      {newestFirst.map(({ text, i }) => (
        <button
          key={i}
          type="button"
          onMouseDown={(e) => {
            // mousedown (not click) so the textarea keeps focus.
            e.preventDefault();
            onPick(i);
          }}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            i === index && 'bg-primary/10 text-foreground',
          )}
          data-testid="entity-execution-history-item"
          data-active={i === index ? 'true' : 'false'}
        >
          <History className="h-3 w-3 shrink-0 opacity-50" />
          <span className="truncate">{text}</span>
        </button>
      ))}
    </div>
  );
}
