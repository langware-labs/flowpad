import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { OAUTH_PROVIDERS, gitOriginFromUrl, gitOriginRepoFullName, oauthService, type RepoSummary } from '@sdk';
import { BranchPicker, type BranchPickerRepo } from '@src/components/git/BranchPicker';
import { InvitationsStrip } from '@src/components/git/InvitationsStrip';
import { RepoPicker } from '@src/components/git/RepoPicker';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { useGithubConnected } from '@src/lib/github-oauth-status';
import { SETUP_GITHUB_JOURNEY_ID, SetupJourneyButton } from '@src/journey/SetupJourneyButton';
import { CheckCircle2, GitBranch, Github } from 'lucide-react';

/** The remote a git flow will use: which repository, and which branch of it. */
export interface GitRemoteValue {
  /** Clone/remote URL. Empty while nothing is chosen. */
  url: string;
  /** Explicit branch, or null for "whatever the remote's default is". */
  branch: string | null;
}

interface GitRemoteFieldProps {
  value: GitRemoteValue;
  onChange: (next: GitRemoteValue) => void;
  /** True while the branch list is showing, so the host can hide its footer
   *  (the picker owns the whole step, including its own Back). */
  onStepChange?: (inPicker: boolean) => void;
  urlLabel?: string;
  urlPlaceholder?: string;
}

/**
 * Choose a git remote AND a branch, by browsing GitHub or by pasting a URL.
 *
 * The one chooser behind every "add git" surface. Both halves are deliberate:
 *
 *  * **Remote** — a free-text URL box alone cannot show which repositories the
 *    user actually has, so the flows built on it either guessed (auto-create a
 *    repo) or made the user go find a URL. `RepoPicker` is the list their token
 *    really reaches.
 *  * **Branch** — a flow that never asks lands on `main`, silently, forever.
 *    That is the same bug `AddHelpdeskDialog` was built to fix; this is that
 *    fix in reusable form. That dialog still carries its own copy and should be
 *    migrated onto this component.
 *
 * Pasting works with no GitHub connection at all — the backend reads public
 * branches anonymously — so a pasted URL gets the branch step too, via
 * `gitOriginFromUrl`. Connecting only buys the browse path and private repos.
 */
export function GitRemoteField({ value, onChange, onStepChange, urlLabel, urlPlaceholder }: GitRemoteFieldProps) {
  const { t } = useLingui();
  const githubConnected = useGithubConnected();
  /** null = step 1 (paste / browse). Non-null = the branch list for this repo. */
  const [branchesFor, setBranchesFor] = useState<BranchPickerRepo | null>(null);

  useEffect(() => {
    onStepChange?.(branchesFor !== null);
  }, [branchesFor, onStepChange]);

  /** The pasted URL as something `BranchPicker` can list branches for.
   *  `default_branch: ''` means "don't pin one to the top" — without asking
   *  GitHub we genuinely do not know which it is. */
  const urlRepo = useMemo<BranchPickerRepo | null>(() => {
    const origin = gitOriginFromUrl(value.url.trim());
    if (!origin) return null;
    return { git_origin: origin, full_name: gitOriginRepoFullName(origin), default_branch: '' };
  }, [value.url]);

  const handlePickRepo = useCallback(
    (repo: RepoSummary) => {
      // A different repo invalidates the branch — never carry one repo's branch
      // name onto another's.
      onChange({ url: `${repo.html_url}.git`, branch: null });
      setBranchesFor(repo);
    },
    [onChange],
  );

  if (branchesFor) {
    return (
      <BranchPicker
        repo={branchesFor}
        onSelect={(b) => {
          onChange({ url: value.url, branch: b.name });
          setBranchesFor(null);
        }}
        onBack={() => setBranchesFor(null)}
      />
    );
  }

  return (
    // `min-w-0`: a grid/flex item defaults to `min-width: auto`, so without this
    // the widest descendant (the repo table, an invitation row) floors this
    // column and it paints straight past the dialog's padding box. The dialog's
    // own `grid-cols-[minmax(0,1fr)]` pins the TRACK, not the item in it.
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="git-remote-url">{urlLabel ?? t`Repository URL`}</Label>
        <div className="flex min-w-0 items-center gap-2">
          <Input
            id="git-remote-url"
            value={value.url}
            onChange={(e) => onChange({ url: e.target.value, branch: value.branch })}
            placeholder={urlPlaceholder ?? 'https://github.com/owner/repo.git'}
            autoComplete="off"
            className="min-w-0 flex-1 font-mono text-xs"
            data-testid="git-remote-url"
          />
          {value.branch ? (
            <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs">
              <GitBranch className="h-3 w-3" />
              <span className="font-mono" data-testid="git-remote-branch">
                {value.branch}
              </span>
              <button
                type="button"
                className="ms-1 text-muted-foreground hover:text-foreground"
                onClick={() => onChange({ url: value.url, branch: null })}
                title={t`Clear branch (uses default)`}
              >
                ×
              </button>
            </div>
          ) : (
            urlRepo && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                onClick={() => setBranchesFor(urlRepo)}
                data-testid="git-remote-pick-branch"
              >
                <GitBranch className="h-3 w-3" />
                <Trans>Pick branch</Trans>
              </Button>
            )
          )}
        </div>
      </div>

      {githubConnected ? (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <Trans>GitHub connected — pick a repository below.</Trans>
          </div>
          <InvitationsStrip provider="github" />
          <RepoPicker provider="github" onSelect={handlePickRepo} />
        </>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">
            {/* Not "connect to continue": a public repo URL needs nothing. */}
            <Trans>Paste any public repo URL, or connect GitHub to browse your own.</Trans>
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => void oauthService.connect(OAUTH_PROVIDERS.GITHUB)}
              data-testid="git-remote-connect-github"
            >
              <Github className="me-1.5 h-3 w-3" />
              <Trans>Connect</Trans>
            </Button>
            <SetupJourneyButton journeyId={SETUP_GITHUB_JOURNEY_ID} variant="ghost">
              <Trans>Guided setup</Trans>
            </SetupJourneyButton>
          </div>
        </div>
      )}
    </div>
  );
}

export default GitRemoteField;
