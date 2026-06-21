import { GitBranch } from 'lucide-react';
import React from 'react';
import { GitPushIcon } from '@src/components/status-bar/GitPushIcon';
import type { PublishState } from '@src/lib/publish-state';

interface PublishPillProps {
  /** Publish state from `derivePublishState` (hidden when `no-repo`). */
  state: PublishState;
  /** Version/identity label shown in the primary zone (e.g. `v3`). Optional. */
  versionLabel?: string;
  /** Label for the Publish action. */
  publishLabel?: string;
  /** Pending count; shown next to Publish only when `showCount`. */
  pendingCount?: number;
  showCount?: boolean;
  /** Publish in flight — disables and spins the publish glyph. */
  busy?: boolean;
  /** Tooltips. */
  primaryTitle?: string;
  publishTitle?: string;
  /** Click the version/identity zone (e.g. open history). */
  onPrimary?: () => void;
  /** Click Publish. */
  onPublish?: () => void;
}

/**
 * Presentational publish pill — the shared visual for the per-asset header and
 * (later) the project footer. NO data fetching and NO view-mode logic: copy and
 * `showCount` are passed in by the stateful container. A primary zone (identity /
 * history) plus a Publish zone shown only when there's something to publish.
 */
export const PublishPill: React.FC<PublishPillProps> = ({
  state,
  versionLabel,
  publishLabel = 'Publish',
  pendingCount = 0,
  showCount = false,
  busy = false,
  primaryTitle,
  publishTitle,
  onPrimary,
  onPublish,
}) => {
  if (state === 'no-repo') return null;
  const canPublish = state === 'unpublished';

  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1" data-testid="publish-pill" data-state={state}>
      <button
        type="button"
        onClick={onPrimary}
        className="inline-flex h-6 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[11px] font-medium text-amber-700 transition-colors hover:border-amber-500/60 hover:bg-amber-500/20 dark:text-amber-300"
        title={primaryTitle ?? 'View history'}
        data-testid="publish-pill-primary"
      >
        <GitBranch className="h-3 w-3 shrink-0" />
        {versionLabel && <span className="tabular-nums">{versionLabel}</span>}
      </button>

      {canPublish && (
        <button
          type="button"
          onClick={onPublish}
          disabled={busy}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[11px] font-medium text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/20 disabled:opacity-60 dark:text-sky-300"
          title={publishTitle ?? 'Publish your changes'}
          data-testid="publish-pill-action"
        >
          <GitPushIcon busy={busy} />
          <span>{publishLabel}</span>
          {showCount && pendingCount > 0 && (
            <span className="tabular-nums rounded-full bg-sky-500/30 px-1 text-[10px]">{pendingCount}</span>
          )}
        </button>
      )}
    </span>
  );
};
