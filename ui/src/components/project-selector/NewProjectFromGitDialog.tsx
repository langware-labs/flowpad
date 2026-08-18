import { OAUTH_PROVIDERS, OAuthStatus, oauthService, type RepoSummary } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { BranchPicker } from '@src/components/git/BranchPicker';
import { InvitationsStrip } from '@src/components/git/InvitationsStrip';
import { RepoPicker } from '@src/components/git/RepoPicker';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { hasGitHubRepoAccess } from '@src/utils/gitUtils';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { SETUP_GITHUB_JOURNEY_ID, SetupJourneyButton } from '@src/journey/SetupJourneyButton';
import { fetchGithubStatus } from '@src/lib/github-oauth-status';
import { CheckCircle2, GitBranch, Github, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export interface NewProjectFromGitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the URL field on open (e.g. opening a repo shared into a
   *  conversation). The user can still edit it before submitting. */
  initialUrl?: string;
  /** Pre-fill the branch chip on open. */
  initialBranch?: string;
  /**
   * Async callback invoked on submit.
   *
   * `acceptSuggested` is set when the user has accepted a name suggestion
   * after a previous collision — pass it through as the target name override
   * so the backend uses it verbatim.
   *
   * `branch` is set when the user picked one via the BranchPicker (or the
   * paste-URL field accepts a #branch suffix in a future iteration).
   *
   * Resolve with `{ ok: false, suggestedName }` to keep the dialog open and
   * render the "use `<suggested>`?" accept banner. Resolve with `{ ok: true }`
   * to let the dialog close. Throw to surface an error toast and stay open.
   */
  onCreate: (
    url: string,
    acceptSuggested?: string,
    branch?: string,
  ) => Promise<{ ok: true } | { ok: false; suggestedName: string; attemptedName: string }>;
}

export function NewProjectFromGitDialog({
  open,
  onOpenChange,
  onCreate,
  initialUrl,
  initialBranch,
}: NewProjectFromGitDialogProps) {
  const { t } = useLingui();
  const [url, setUrl] = useState(initialUrl ?? '');
  const [branch, setBranch] = useState<string | null>(initialBranch ?? null);
  // One user action, two sequential phases — never concurrent, so one value
  // rather than a pair of booleans that can disagree.
  const [phase, setPhase] = useState<'idle' | 'checking' | 'cloning'>('idle');
  const [accessError, setAccessError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ suggestedName: string; attemptedName: string } | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean>(false);
  // null = the repo list has not resolved yet, so we do not yet know.
  const [privateReposVisible, setPrivateReposVisible] = useState<boolean | null>(null);
  // Picker state: null = step 1 (repo table). Non-null = step 2 (branches for this repo).
  const [pickedRepo, setPickedRepo] = useState<RepoSummary | null>(null);
  // Last URL that passed the access probe — lets a collision retry skip a
  // second identical `ls-remote` for a repo already proven readable.
  const probedUrlRef = useRef<string | null>(null);

  // Re-poll on every open AND whenever userTypeId becomes available — handles
  // the bootstrap race where the dialog mounts before dataContext.userTypeId is
  // populated (fetchGithubStatus returns null in that case).
  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl ?? '');
    setBranch(initialBranch ?? null);
    setPickedRepo(null);
    setPhase('idle');
    setAccessError(null);
    setSuggestion(null);
    probedUrlRef.current = null;

    let cancelled = false;
    const poll = async () => {
      const result = await fetchGithubStatus();
      if (cancelled) return;
      if (result === null) {
        // Couldn't determine — retry briefly. The userTypeId usually arrives
        // within the first second of bootstrap.
        setTimeout(() => {
          if (!cancelled) void poll();
        }, 500);
        return;
      }
      setGithubConnected(result);
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [open, initialUrl, initialBranch]);

  // Refresh status when a GitHub grant lands.
  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (msg) => {
      if (msg.status !== OAuthStatus.SUCCESS) return;
      // A stale "no access" verdict was reached WITHOUT the token that just
      // arrived — drop it so the user isn't looking at an answer that no
      // longer holds. Re-clicking Clone re-probes with the new credential.
      setAccessError(null);
      void fetchGithubStatus().then((r) => {
        if (r !== null) setGithubConnected(r);
      });
    },
    open,
  );

  const handleConnectGithub = useCallback(async () => {
    try {
      await oauthService.connect(OAUTH_PROVIDERS.GITHUB);
    } catch (err) {
      // Prefer the backend's ApiFailResponse message over axios's generic
      // "Request failed with status code 500".
      const ax = err as { response?: { data?: { message?: string } }; message?: string };
      const title = ax.response?.data?.message ?? ax.message ?? t`Failed to start GitHub connection`;
      notify.error({ title });
    }
  }, [t]);

  const isBusy = phase !== 'idle';
  const canSubmit = !!url.trim() && !isBusy;

  const submit = useCallback(
    async (acceptSuggested?: string) => {
      const target = url.trim();
      if (isBusy || !target) return;
      try {
        // Gate on the SAME credential path the clone will use, so we never
        // commit to a clone we already know fails. `null` means the question
        // couldn't be asked at all (bad URL / backend unreachable) — a
        // different failure from a real denial, so it gets its own message.
        // Skipped once a URL has been cleared, so accepting a name suggestion
        // doesn't re-probe a repo we just proved readable.
        // `/api/v1/git/remote-access` is a flow_sdk route; the hub registers no
        // git router, so on hub the probe 404s and `hasGitHubRepoAccess` reports
        // "couldn't reach" for every repo — including ones we can demonstrably
        // read. Skip the question where it cannot be asked; the clone itself
        // reports the real failure.
        if (!isHubOnly() && probedUrlRef.current !== target) {
          setPhase('checking');
          setAccessError(null);
          const access = await hasGitHubRepoAccess(target);
          if (!access?.hasAccess) {
            setAccessError(
              access === null
                ? t`Couldn't reach that repository. Check the URL and try again.`
                : t`No access to this repository. Connect GitHub if it's private, or check the URL.`,
            );
            return;
          }
          probedUrlRef.current = target;
        }

        setPhase('cloning');
        const res = await onCreate(target, acceptSuggested, branch ?? undefined);
        if (res.ok) {
          onOpenChange(false);
        } else {
          setSuggestion({ suggestedName: res.suggestedName, attemptedName: res.attemptedName });
        }
      } catch (err) {
        notify.error({
          title: err instanceof Error ? err.message : t`Failed to clone repository`,
        });
      } finally {
        setPhase('idle');
      }
    },
    [isBusy, url, branch, onCreate, onOpenChange, t],
  );

  const handlePickRepo = useCallback(
    (repo: RepoSummary) => {
      setPickedRepo(repo);
      setBranch(null); // require explicit branch choice after picking a different repo
      // Pre-fill the URL field so the user can see what they picked even before
      // choosing a branch; selecting a branch only updates the branch chip.
      setUrl(`${repo.html_url}.git`);
      if (suggestion) setSuggestion(null);
    },
    [suggestion],
  );

  const handlePickBranch = useCallback((b: { name: string }) => {
    setBranch(b.name);
  }, []);

  // Block ESC / outside-click / `×` close while a clone is in flight — those
  // would otherwise unmount the dialog mid-fetch, dropping the toast surface
  // for collision/error responses and leaving the user confused about what
  // happened. The footer Cancel button is separately disabled in JSX below.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && isBusy) return;
      onOpenChange(next);
    },
    [isBusy, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onEscapeKeyDown={(e) => {
          if (isBusy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (isBusy) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (isBusy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Clone project from git</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {githubConnected ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              {/* "Connected" is all `github/status` proves — it is a stored token
                  row, with no scope check and no call to GitHub. Whether that
                  token can reach PRIVATE repos is only knowable once the list
                  comes back, so the stronger claim waits for evidence. */}
              {privateReposVisible === true ? (
                <Trans>GitHub connected — private repos included.</Trans>
              ) : privateReposVisible === false ? (
                <Trans>GitHub connected — no private repos visible to this token.</Trans>
              ) : (
                <Trans>GitHub connected.</Trans>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
              <span className="text-muted-foreground">
                <Trans>Tip: connect GitHub to clone private repos.</Trans>
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => void handleConnectGithub()}
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
          {/* URL input (always visible) */}
          <div className="flex items-center gap-2">
            <Input
              placeholder={t`https://github.com/owner/repo.git`}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (suggestion) setSuggestion(null);
                if (accessError) setAccessError(null);
              }}
              autoFocus
              spellCheck={false}
              className="font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit();
              }}
            />
            {branch && (
              <div className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs">
                <GitBranch className="h-3 w-3" />
                <span className="font-mono">{branch}</span>
                <button
                  type="button"
                  className="ms-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setBranch(null)}
                  title={t`Clear branch (uses default)`}
                >
                  ×
                </button>
              </div>
            )}
          </div>
          {suggestion && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <div className="mb-1.5">
                <Trans>
                  <span className="font-mono">{suggestion.attemptedName}</span> already exists in the workspace.
                </Trans>
              </div>
              <div className="flex items-center gap-2">
                <span>
                  <Trans>Use</Trans>
                </span>
                <span className="font-mono font-medium">{suggestion.suggestedName}</span>
                <span>
                  <Trans>instead?</Trans>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-auto h-6 px-2 text-xs"
                  onClick={() => void submit(suggestion.suggestedName)}
                  disabled={isBusy}
                >
                  <Trans>Use suggestion</Trans>
                </Button>
              </div>
            </div>
          )}
          {accessError && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="git-access-error"
            >
              {accessError}
            </div>
          )}
          {isBusy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'checking' ? <Trans>Checking access…</Trans> : <Trans>Cloning…</Trans>}
            </div>
          )}

          {/* Picker section: only when connected. URL input above remains the
              manual-paste path; this is the discoverable browse path. */}
          {githubConnected && (
            <>
              <div className="my-1 border-t border-border" />
              <InvitationsStrip provider="github" enabled={open} />
              {pickedRepo ? (
                <BranchPicker
                  repo={pickedRepo}
                  onSelect={handlePickBranch}
                  onBack={() => {
                    setPickedRepo(null);
                    setBranch(null);
                  }}
                />
              ) : (
                <RepoPicker
                  provider="github"
                  onSelect={handlePickRepo}
                  enabled={open}
                  onReposLoaded={(repos) => setPrivateReposVisible(repos.some((r) => r.private))}
                />
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="git-clone-submit">
            {isBusy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            {branch ? <Trans>Clone @ {branch}</Trans> : <Trans>Clone</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewProjectFromGitDialog;
