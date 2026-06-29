import { Trans, useLingui } from '@lingui/react/macro';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { WORKER_TYPES, type WorkerType } from '@src/hooks/useWorkerHistory';

/** Vendor labels — derived from the worker-history value space (single source). */
const WORKER_LABELS: Record<WorkerType, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };

interface ChatsFilterBarProps {
  /** Start a fresh chat with the given vendor. */
  onNewChat: (worker: WorkerType) => void;
}

/**
 * The Chats navigator "New" launcher row below the title — one icon per vendor
 * that starts a fresh chat (Claude/Codex/Copilot). Search lives in the shared
 * NavigatorPanel header (the magnifier icon), and the scope filter in the title
 * row (`header.headerRight`), like every other navigator.
 */
export function ChatsFilterBar({ onNewChat }: ChatsFilterBarProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1.5 border-b px-2 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"><Trans>New</Trans></span>
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
        </div>
      </div>
    </div>
  );
}
