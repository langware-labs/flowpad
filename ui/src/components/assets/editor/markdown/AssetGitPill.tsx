import React from 'react';
import { useViewMode } from '@src/components/view-mode';
import { PublishPill } from '@src/components/git/PublishPill';
import { derivePublishState, publishCopy } from '@src/lib/publish-state';
import { useGitPush } from '@src/hooks/use-git-push';

interface AssetGitPillProps {
  /** Current asset version (from frontmatter via git history), or null. */
  version: number | null;
  /** Local revisions of this file not yet published (commits ahead of remote). */
  unpushed: number;
  /** True when the file is in a git repo with history. */
  hasRepo: boolean;
  /** Compute node + working dir (the file's own repo) for the publish action. */
  computeNodeId: string | null;
  workdir: string | null;
  /** Open the Revisions side panel. */
  onOpenHistory: () => void;
  /** Refresh the revision status after a publish (so the count clears). */
  onAfterPublish?: () => void;
}

/**
 * Stateful container for the per-asset publish pill. Builds the publish state +
 * push handler ONCE (unconditionally), then lets the view mode pick copy/arrangement
 * only — Standard sees plain "Publish" with no git jargon or commit count; Advanced
 * sees the count and richer messages. Renders the shared, presentational `PublishPill`
 * so the project footer can reuse the same component later. Hidden when not in a repo.
 */
export const AssetGitPill: React.FC<AssetGitPillProps> = ({
  version,
  unpushed,
  hasRepo,
  computeNodeId,
  workdir,
  onOpenHistory,
  onAfterPublish,
}) => {
  const mode = useViewMode();
  const status = derivePublishState({ hasRepo, unpushed });
  const labels = publishCopy(status.state, mode);
  const { push, busy } = useGitPush(computeNodeId, workdir, onAfterPublish);

  return (
    <PublishPill
      state={status.state}
      versionLabel={version != null ? `v${version}` : undefined}
      publishLabel={labels.publishLabel}
      publishTitle={labels.publishTitle}
      pendingCount={status.pendingCount}
      showCount={labels.showCount}
      busy={busy}
      primaryTitle="View history"
      onPrimary={onOpenHistory}
      onPublish={() => void push()}
    />
  );
};
