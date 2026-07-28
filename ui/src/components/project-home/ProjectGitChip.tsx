import { GitBranch, Loader2, Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { capabilityManager, CapabilityKinds, gitOriginRepoFullName, gitOriginWebUrl } from '@sdk';
import type { CapabilityAccess, TypeId } from '@sdk';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { openExternal } from '@src/lib/open-external';

/** One readiness question and how it came out. */
export interface GitCheck {
  id: 'installed' | 'setup' | 'logged-in';
  label: string;
  ok: boolean | null;
  detail: string | null;
}

interface ProjectGitChipProps {
  projectTypeId: TypeId;
  /** Called with the check results when the user asks to add git. */
  onChecked?: (checks: GitCheck[]) => void;
}

/**
 * The project header's Git slot: the repo it publishes to, or a way to add one.
 *
 * Reads `git_share_preflight`, which derives the origin locally (no network) —
 * and now returns it even when the tree is dirty or unpushed, so a real repo is
 * still named rather than being offered an "Add git" button it doesn't need.
 */
export function ProjectGitChip({ projectTypeId, onChecked }: ProjectGitChipProps) {
  const { t } = useLingui();
  const preflight = useGitSharePreflight(projectTypeId, true);
  const [checking, setChecking] = useState(false);

  const origin = preflight.origin;
  if (origin) {
    // Repo root, not a deep link: the chip names the project's repo, not a file.
    const repo = gitOriginRepoFullName(origin);
    const href = gitOriginWebUrl({ ...origin, rel_path: '.' });
    const body = (
      <>
        <GitBranch className="h-3.5 w-3.5" aria-hidden />
        <span className="truncate">{repo}</span>
      </>
    );
    return href ? (
      <a
        href={href}
        onClick={(e) => {
          // Keep the repo in the user's real browser: a bare target=_blank does
          // not escape the Electron shell.
          e.preventDefault();
          openExternal(href);
        }}
        title={href}
        data-testid="project-git-repo"
        className="inline-flex max-w-[16rem] items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        {body}
      </a>
    ) : (
      <span
        data-testid="project-git-repo"
        title={repo}
        className="inline-flex max-w-[16rem] items-center gap-1.5 text-xs text-muted-foreground"
      >
        {body}
      </span>
    );
  }

  // Nothing to name yet. The button's ONLY job is to report where git stands —
  // what to do about each answer isn't defined yet, so it deliberately starts
  // nothing.
  const runChecks = async () => {
    setChecking(true);
    try {
      // Read the capability SUMMARY, not `capabilities/test`. The test endpoint
      // only accepts `source_control.git.github` WITH a scope, and its
      // project-scoped probe walks git and can reach the remote (~1s+ here) to
      // answer a question this button already knows: there is no origin. The
      // summary is the backend's own cached snapshot, seeded into the client at
      // bootstrap — so this is local, and returns in a frame.
      const summary = await capabilityManager.getSummary();
      const byKind = new Map<string, CapabilityAccess>(
        (summary?.capabilities ?? []).map((c) => [c.kind, c]),
      );
      const gh = byKind.get(CapabilityKinds.GitHubGh);
      const github = byKind.get(CapabilityKinds.GitHub);

      onChecked?.([
        {
          // No probe exists for the git binary itself — the nearest signal is
          // the gh CLI capability, which reports installed+authenticated
          // together. Named for what it measures rather than what we wish it did.
          id: 'installed',
          label: t`Git tooling installed`,
          ok: gh ? gh.available : null,
          detail: gh?.message || null,
        },
        {
          // This button only renders when no origin could be derived, so the
          // answer is already known — the preflight's reason says which part is
          // missing (no repo / no remote / an origin we can't place).
          id: 'setup',
          label: t`Repository and remote configured`,
          ok: false,
          detail: preflight.reason,
        },
        {
          id: 'logged-in',
          label: t`Signed in to the remote`,
          ok: github ? github.available : null,
          detail: github?.message || null,
        },
      ]);
      // Re-read the local git state so the chip flips to the repo name if one
      // appeared since mount. Not awaited: nothing above depends on it.
      preflight.refetch();
    } finally {
      setChecking(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void runChecks()}
      disabled={checking}
      aria-label={t`Add Git`}
      title={t`Add Git`}
      data-testid="project-git-add"
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      {checking ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Plus className="h-3.5 w-3.5" aria-hidden />
      )}
      <GitBranch className="h-3.5 w-3.5" aria-hidden />
      <span>
        <Trans>Add Git</Trans>
      </span>
    </button>
  );
}
