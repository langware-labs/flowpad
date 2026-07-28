import { GitBranch, Loader2, Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import apiClient from '@sdk/client';
import { CapabilityKinds } from '@sdk';
import type { TypeId } from '@sdk';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';

/** Browse URL for a repo coordinate. Providers we can't map get no link. */
const BROWSE_HOST: Record<string, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  bitbucket: 'https://bitbucket.org',
};

/** One readiness question and how it came out. */
export interface GitCheck {
  id: 'installed' | 'setup' | 'logged-in';
  label: string;
  ok: boolean | null;
  detail: string | null;
}

interface ProjectGitChipProps {
  projectTypeId: TypeId;
  projectId: string;
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
export function ProjectGitChip({ projectTypeId, projectId, onChecked }: ProjectGitChipProps) {
  const { t } = useLingui();
  const preflight = useGitSharePreflight(projectTypeId, true);
  const [checking, setChecking] = useState(false);

  const origin = preflight.origin;
  if (origin) {
    const repo = `${origin.owner}/${origin.name}`;
    const host = BROWSE_HOST[origin.provider.toLowerCase()];
    const href = host ? `${host}/${repo}` : null;
    const body = (
      <>
        <GitBranch className="h-3.5 w-3.5" aria-hidden />
        <span className="truncate">{repo}</span>
      </>
    );
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
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
      const github = await apiClient
        .post<{ result?: { available?: boolean; message?: string } }>('/graph/capabilities/test', {
          kind: CapabilityKinds.GitHub,
          scope_type: 'project',
          scope_id: projectId,
        })
        .catch(() => null);
      const gh = await apiClient
        .post<{ result?: { available?: boolean; message?: string } }>('/graph/capabilities/test', {
          kind: CapabilityKinds.GitHubGh,
        })
        .catch(() => null);

      preflight.refetch();
      onChecked?.([
        {
          // No probe exists for the git binary itself — the closest signal we
          // have is the gh CLI capability, which reports installed+authed
          // together. Reported honestly rather than inferred.
          id: 'installed',
          label: t`Git tooling installed`,
          ok: gh?.result?.available ?? null,
          detail: gh?.result?.message ?? null,
        },
        {
          id: 'setup',
          label: t`Repository and remote configured`,
          ok: preflight.code !== 'not-in-repo' && preflight.code !== 'missing-remote' ? null : false,
          detail: preflight.reason,
        },
        {
          id: 'logged-in',
          label: t`Signed in to the remote`,
          ok: github?.result?.available ?? null,
          detail: github?.result?.message ?? null,
        },
      ]);
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
