import { Play } from 'lucide-react';
import { workerIcon, workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { LAUNCHABLE_WORKERS, type WorkerType } from './conversation-session-constants';

/**
 * Presentational worker-session affordance shared by every surface that owns a
 * single worker session (conversation header, received-transcript viewer, …).
 * Renders exactly one of two states (never neither):
 *
 *   - a process exists  → a single **Open** button → its live shell;
 *   - none exists       → a **launch toolbar** (claude_code / codex / copilot).
 *
 * Purely presentational: the host supplies `hasProcess` and the `onOpen` /
 * `onLaunch` callbacks. Glyph + label come from the shared worker-vendor helpers
 * so every surface matches. The host owns any project-mapping gate / dialog.
 */
export function WorkerLaunchToolbar({
  hasProcess,
  starting,
  onOpen,
  onLaunch,
  openTitle = 'Open the session',
  testIdPrefix = 'worker',
}: {
  hasProcess: boolean;
  starting: boolean;
  onOpen: () => void;
  onLaunch: (worker: WorkerType) => void;
  openTitle?: string;
  testIdPrefix?: string;
}) {
  if (hasProcess) {
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

  return (
    <div className="inline-flex items-center gap-1" data-testid={`${testIdPrefix}-launch-toolbar`}>
      {LAUNCHABLE_WORKERS.map((worker) => {
        const Icon = workerIcon(worker);
        return (
          <button
            key={worker}
            type="button"
            onClick={() => onLaunch(worker)}
            disabled={starting}
            data-testid={`${testIdPrefix}-launch-${worker}`}
            title={`Start ${workerLabel(worker)}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
