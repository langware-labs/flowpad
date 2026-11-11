import { OAUTH_PROVIDERS, OAuthStatus } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { GitRepoPicker, type GitTarget } from '@src/components/git/GitRepoPicker';
import { splitGitBranch } from './git-url';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { notify } from '@src/notifications';
import { hasGitHubRepoAccess } from '@src/utils/gitUtils';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { Loader2 } from 'lucide-react';
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
  // The branch list owns the body while open (it carries its own Back).
  const [inBranchPicker, setInBranchPicker] = useState(false);
  // Last URL that passed the access probe — lets a collision retry skip a
  // second identical `ls-remote` for a repo already proven readable.
  const probedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl ?? '');
    setBranch(initialBranch ?? null);
    setPhase('idle');
    setAccessError(null);
    setSuggestion(null);
    probedUrlRef.current = null;
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
    },
    open,
  );

  const isBusy = phase !== 'idle';
  const canSubmit = !!url.trim() && !isBusy;

  const submit = useCallback(
    async (acceptSuggested?: string) => {
      // A pasted `…/tree/<branch>` or `…#<branch>` names the branch too; one picked wins.
      const { url: target, branch: pastedBranch } = splitGitBranch(url);
      const chosenBranch = branch ?? pastedBranch;
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
        const res = await onCreate(target, acceptSuggested, chosenBranch ?? undefined);
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

  // The shared repo picker reports the remote + branch; a new choice drops a
  // stale collision suggestion or access verdict.
  const handlePick = useCallback((target: GitTarget | null) => {
    setUrl(target?.mode === 'existing' ? target.url : '');
    setBranch(target?.mode === 'existing' ? (target.branch ?? null) : null);
    setSuggestion(null);
    setAccessError(null);
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
          <GitRepoPicker
            modes={['existing']}
            onChange={handlePick}
            onStepChange={setInBranchPicker}
            onEnter={() => canSubmit && void submit()}
            initialUrl={initialUrl}
            initialBranch={initialBranch}
            urlPlaceholder={t`https://github.com/owner/repo.git`}
            enabled={open}
            testIdPrefix="git-clone"
          />
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
        </div>
        {!inBranchPicker && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="git-clone-submit">
              {isBusy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {branch ? <Trans>Clone @ {branch}</Trans> : <Trans>Clone</Trans>}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default NewProjectFromGitDialog;
