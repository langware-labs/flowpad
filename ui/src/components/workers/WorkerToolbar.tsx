import { useState } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { useIsDev } from '@src/components/view-mode';
import {
  workerIcon,
  workerLabel,
} from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { LAUNCHABLE_WORKERS, type WorkerType } from '@src/components/workers/worker-types';
import { useLastWorkerType } from '@src/components/terminal/openers/useLastWorkerType';

export type WorkerToolbarMode = 'lastOpened' | 'all';
export type WorkerToolbarVariant = 'icon-row' | 'menu-list';

interface WorkerToolbarProps {
  /** Launch the chosen worker. The toolbar persists it as the last opener. */
  onLaunch: (worker: WorkerType) => void | Promise<void>;
  /** Single-session surfaces: when a process exists, show **Open** instead of the row. */
  hasProcess?: boolean;
  onOpen?: () => void;
  openTitle?: string;
  /** Disable launch buttons while a launch is in flight. */
  starting?: boolean;
  /**
   * Display mode. Defaults to `lastOpened` (only the last-used worker, others
   * behind a chevron), except in Dev view where it defaults to `all`. An
   * explicit prop always wins.
   */
  mode?: WorkerToolbarMode;
  /** `icon-row` (default) or `menu-list` (vertical labelled rows, e.g. the "+" menu). */
  variant?: WorkerToolbarVariant;
  testIdPrefix?: string;
}

/**
 * The single worker-launch affordance shared by every surface that offers
 * "start a worker (claude_code / codex / copilot)". Presentational + display-mode
 * logic only — the host owns the actual launch via `onLaunch` (and any project /
 * asset context it threads in there).
 *
 * Two render shapes:
 *   - `icon-row`   — square vendor icons (header toolbars, pickers);
 *   - `menu-list`  — full-width labelled rows ("Session — Claude", the "+" menu).
 *
 * Two display modes:
 *   - `all`        — every vendor (today's behavior; the Dev-view default);
 *   - `lastOpened` — the last-used vendor up front, the rest behind a chevron
 *                    (the standard-view default). Launching remembers the choice
 *                    in the shared last-opener key, so it surfaces first next time.
 */
export function WorkerToolbar({
  onLaunch,
  hasProcess = false,
  onOpen,
  openTitle = 'Open the session',
  starting = false,
  mode,
  variant = 'icon-row',
  testIdPrefix = 'worker',
}: WorkerToolbarProps) {
  const isDev = useIsDev();
  const { lastWorker, rememberWorker } = useLastWorkerType();
  const [expanded, setExpanded] = useState(false);

  const effectiveMode: WorkerToolbarMode = mode ?? (isDev ? 'all' : 'lastOpened');

  const launch = (worker: WorkerType) => {
    rememberWorker(worker);
    void onLaunch(worker);
  };

  if (hasProcess && onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        data-testid={`${testIdPrefix}-open-session`}
        className="inline-flex h-7 items-center gap-1.5 rounded border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        title={openTitle}
      >
        <Play className="h-3.5 w-3.5 text-orange-500" />
        <span>Open</span>
      </button>
    );
  }

  // In lastOpened mode, lead with the last worker (fallback to the first vendor)
  // and keep the rest behind the chevron. In all mode, show everything.
  const primary: WorkerType = lastWorker ?? LAUNCHABLE_WORKERS[0];
  const rest = LAUNCHABLE_WORKERS.filter((w) => w !== primary);
  const visibleWorkers: WorkerType[] =
    effectiveMode === 'all' || expanded ? [primary, ...rest] : [primary];
  const showChevron = effectiveMode === 'lastOpened' && !expanded && rest.length > 0;

  if (variant === 'menu-list') {
    return (
      <div className="flex flex-col" data-testid={`${testIdPrefix}-launch-menu`}>
        {visibleWorkers.map((worker) => {
          const Icon = workerIcon(worker);
          return (
            <button
              key={worker}
              type="button"
              onClick={() => launch(worker)}
              disabled={starting}
              data-testid={`${testIdPrefix}-launch-${worker}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Icon className="h-3 w-3" />
              Session — {workerLabel(worker)}
            </button>
          );
        })}
        {showChevron && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            data-testid={`${testIdPrefix}-launch-more`}
            title="Show other workers"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted"
          >
            <ChevronRight className="h-3 w-3" />
            More…
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1" data-testid={`${testIdPrefix}-launch-toolbar`}>
      {visibleWorkers.map((worker) => {
        const Icon = workerIcon(worker);
        return (
          <button
            key={worker}
            type="button"
            onClick={() => launch(worker)}
            disabled={starting}
            data-testid={`${testIdPrefix}-launch-${worker}`}
            title={`Start ${workerLabel(worker)}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
      {showChevron && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid={`${testIdPrefix}-launch-more`}
          title="Show other workers"
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded border border-border',
            'text-muted-foreground transition-colors hover:bg-muted',
          )}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
