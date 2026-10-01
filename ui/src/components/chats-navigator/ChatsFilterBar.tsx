import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { FolderClock, Search, X } from 'lucide-react';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { WORKER_LABELS, WORKER_TYPES, type WorkerType } from '@src/hooks/useWorkerHistory';

interface ChatsFilterBarProps {
  /** Start a fresh chat with the given vendor. */
  onNewChat: (worker: WorkerType) => void;
  /** Restore a session by pasting its id (UUID). */
  onResumeById: () => void;
  /** Quick-search mode: the whole row becomes a session search line. */
  searchOpen: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onSearchOpenChange: (open: boolean) => void;
}

/**
 * The Chats navigator "New" launcher row below the title — one icon per vendor
 * that starts a fresh chat (Claude/Codex/Copilot). The scope filter lives in
 * the title row (`header.headerRight`), like every other navigator; the panel
 * header carries no search of its own — the quick search below replaces it.
 *
 * The trailing magnifier is a session QUICK search: it swaps the whole row for
 * a text line that filters the chat list below (sessions only, same rows,
 * latest first). Esc or the X closes it and clears the query.
 */
export function ChatsFilterBar({
  onNewChat,
  onResumeById,
  searchOpen,
  search,
  onSearchChange,
  onSearchOpenChange,
}: ChatsFilterBarProps) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  if (searchOpen) {
    return (
      <div className="flex flex-col gap-1.5 px-2 py-2">
        <div className="flex h-6 items-center gap-1.5 rounded border bg-background px-1.5 focus-within:border-ring">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onSearchOpenChange(false);
              }
            }}
            placeholder={t`Search sessions…`}
            aria-label={t`Search sessions`}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            data-testid="chats-quick-search-input"
          />
          <button
            type="button"
            onClick={() => onSearchOpenChange(false)}
            title={t`Close search`}
            aria-label={t`Close search`}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="chats-quick-search-close"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <Trans>New</Trans>
        </span>
        <div className="flex items-center gap-0.5">
          {WORKER_TYPES.map((value) => {
            const label = WORKER_LABELS[value];
            return (
              <button
                key={value}
                type="button"
                onClick={() => onNewChat(value)}
                title={t`New ${label} chat`}
                aria-label={t`New ${label} chat`}
                className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-muted"
                data-testid={`chats-new-${value}`}
              >
                <WorkerIcon workerType={value} className="h-3.5 w-3.5 shrink-0" />
              </button>
            );
          })}
          {/* Generic (vendor-agnostic) "restore from history" — sits alongside the
              start-new-worker buttons; prompts for a session id and resumes it. */}
          <button
            type="button"
            onClick={onResumeById}
            title={t`Restore session by id`}
            aria-label={t`Restore session by id`}
            className="ms-0.5 flex h-6 w-6 items-center justify-center rounded border-s ps-1.5 transition-colors hover:bg-muted"
            data-testid="chats-resume-by-id"
          >
            <FolderClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => onSearchOpenChange(true)}
          title={t`Search sessions`}
          aria-label={t`Search sessions`}
          className="ms-auto flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-muted"
          data-testid="chats-quick-search"
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
