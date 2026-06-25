import { Search, Star } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { WORKER_TYPES, type WorkerType } from '@src/hooks/useWorkerHistory';
import type { ScopeFilter } from '@src/lib/scope-filter';

/** Vendor chips — derived from the worker-history value space (single source). */
const WORKER_LABELS: Record<WorkerType, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };

interface ChatsFilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  scope: ScopeFilter;
  currentProjectId: string | null;
  currentProjectName: string | null;
  onScopeChange: (scope: ScopeFilter) => void;
  workers: readonly string[];
  onToggleWorker: (value: string) => void;
  favoritesOnly: boolean;
  onToggleFavorites: () => void;
}

/**
 * The Chats navigator header controls: search box, project scope (shared
 * ScopeFilterIconBar, same as Assets), worker-vendor chips, and a favorites
 * toggle. Pure controlled inputs — all state lives in the navigator.
 */
export function ChatsFilterBar({
  search,
  onSearchChange,
  scope,
  currentProjectId,
  currentProjectName,
  onScopeChange,
  workers,
  onToggleWorker,
  favoritesOnly,
  onToggleFavorites,
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
      <div className="flex items-center justify-between gap-1">
        <ScopeFilterIconBar
          scope={scope}
          currentProjectId={currentProjectId}
          currentProjectName={currentProjectName}
          onScopeChange={onScopeChange}
        />
        <div className="flex items-center gap-0.5">
          {WORKER_TYPES.map((value) => {
            const label = WORKER_LABELS[value];
            const active = workers.includes(value);
            return (
              <button
                key={value}
                type="button"
                onClick={() => onToggleWorker(value)}
                title={active ? `Hide ${label}` : `Only ${label}`}
                aria-label={`Toggle ${label}`}
                aria-pressed={active}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-muted',
                  active ? 'bg-muted ring-1 ring-primary/40' : 'opacity-50',
                )}
              >
                <WorkerIcon workerType={value} className="h-3.5 w-3.5 shrink-0" />
              </button>
            );
          })}
          <button
            type="button"
            onClick={onToggleFavorites}
            title={favoritesOnly ? 'Show all' : 'Favorites only'}
            aria-label="Toggle favorites"
            aria-pressed={favoritesOnly}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-muted',
              favoritesOnly && 'bg-muted ring-1 ring-primary/40',
            )}
          >
            <Star className={cn('h-3.5 w-3.5', favoritesOnly ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
          </button>
        </div>
      </div>
    </div>
  );
}
