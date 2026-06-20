import { GitBranch } from 'lucide-react';
import React from 'react';

interface AssetGitPillProps {
  /** Current asset version (from frontmatter via git history), or null. */
  version: number | null;
  /** Local revisions of this file not yet pushed (mirrors the footer pill). */
  unpushed: number;
  /** True when the file is in a git repo with history. */
  hasRepo: boolean;
  /** Open the Revisions side panel. */
  onClick: () => void;
}

/**
 * Header pill for an asset's git revision history — the per-file analogue of the
 * footer ``GitStatusPill``. Shows the running ``v{n}`` version always (when the
 * file has history) and badges the count of unpushed local revisions. Clicking
 * opens the Revisions side panel. Hidden when the file isn't under git.
 */
export const AssetGitPill: React.FC<AssetGitPillProps> = ({ version, unpushed, hasRepo, onClick }) => {
  if (!hasRepo) return null;
  const pending = unpushed > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[11px] font-medium text-amber-700 transition-colors hover:border-amber-500/60 hover:bg-amber-500/20 dark:text-amber-300"
      title={
        pending
          ? `${unpushed} unpushed revision${unpushed === 1 ? '' : 's'} — click to view history`
          : 'View revision history'
      }
      data-testid="asset-git-pill"
    >
      <GitBranch className="h-3 w-3 shrink-0" />
      {version != null && <span className="tabular-nums">v{version}</span>}
      {pending && (
        <span className="tabular-nums rounded-full bg-amber-500/30 px-1 text-[10px]">{unpushed}</span>
      )}
    </button>
  );
};
