import { Search } from 'lucide-react';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { WORKER_TYPES, type WorkerType } from '@src/hooks/useWorkerHistory';

/** Vendor labels — derived from the worker-history value space (single source). */
const WORKER_LABELS: Record<WorkerType, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };

interface ChatsFilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Start a fresh chat with the given vendor. */
  onNewChat: (worker: WorkerType) => void;
}

/**
 * The Chats navigator header controls below the title row, stacked one-per-row:
 *   1. search box
 *   2. a "New" launcher row — one icon per vendor that starts a fresh chat
 *      (Claude/Codex/Copilot), replacing the lone "+".
 * The scope filter lives in the title row (`header.headerRight`) like every
 * other navigator. Pure controlled inputs — all state lives in the navigator.
 */
export function ChatsFilterBar({
  search,
  onSearchChange,
  onNewChat,
}: ChatsFilterBarProps) {
  return (
    <div className="flex flex-col gap-1.5 border-b px-2 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none transition-colors focus:border-primary"
          data-testid="chats-search"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">New</span>
        <div className="flex items-center gap-0.5">
          {WORKER_TYPES.map((value) => {
            const label = WORKER_LABELS[value];
            return (
              <button
                key={value}
                type="button"
                onClick={() => onNewChat(value)}
                title={`New ${label} chat`}
                aria-label={`New ${label} chat`}
                className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-muted"
                data-testid={`chats-new-${value}`}
              >
                <WorkerIcon workerType={value} className="h-3.5 w-3.5 shrink-0" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
