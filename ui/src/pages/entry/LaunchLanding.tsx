import { gitOriginFromUrl } from '@sdk';
import { formatGitOrigin, gitOriginCloneUrl } from '@sdk/models/GitOrigin';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useSandboxes } from '@src/hooks/use-sandboxes';
import { StepList } from '@src/components/ui/step-list';
import { ExternalLink, GitBranch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * `/launch?repo=<git url>` — the one-click entry point for "try this repo".
 *
 * A link anyone can share: opening it lands here, and because the link came
 * from OUTSIDE the app, launching a cloud sandbox on its say-so is never
 * automatic — the repo is spelled out and the user approves it. On approve we
 * run the SAME pipeline the New Sandbox dialog does (`useSandboxes().launch`):
 * create the box → wait for FlowPad + sign-in → open it ON its clone landing,
 * where the box clones the repo into a fresh indexed Project. The repo's own
 * auto-launch journey then greets the user inside.
 *
 * `?name=` overrides the project/desktop name, `?branch=` the branch.
 */
export default function LaunchLanding() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const { launch, steps, launchUrl } = useSandboxes();
  const [declined, setDeclined] = useState(false);

  const repo = params.get('repo') ?? '';
  const branch = params.get('branch') ?? '';
  const gitOrigin = useMemo(() => (repo ? gitOriginFromUrl(repo, branch) : null), [repo, branch]);
  const name = (params.get('name') || gitOrigin?.name || '').trim();

  // Once launching has started, never re-show the confirm — a step that fails
  // must leave its error on screen, not bounce the user back to "shall we?".
  const [started, setStarted] = useState(false);
  const failed = steps.some((s) => s.status === 'error');

  const onLaunch = () => {
    if (!gitOrigin) return;
    setStarted(true);
    // Inside the click gesture — `launch` claims the new tab synchronously.
    // The hub sets the sandbox up (it holds the token, so a private repo works
    // here too) and the tab lands inside the project it created.
    void launch({ name, sandboxProject: { gitOrigin, name } });
  };

  const body = (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center">
        {started ? (
          <div className="rounded-lg border border-border p-5 text-start">
            <p className="mb-3 text-sm font-medium">
              {launchUrl ? (
                <Trans>Your sandbox is ready</Trans>
              ) : failed ? (
                <Trans>Couldn't finish preparing your sandbox</Trans>
              ) : (
                <Trans>Preparing your sandbox…</Trans>
              )}
            </p>
            <StepList steps={steps} testIdPrefix="launch" className="flex flex-col gap-1.5" />
            {launchUrl && (
              <Button asChild size="sm" className="mt-4 w-full gap-1.5">
                <a href={launchUrl} target="_blank" rel="noreferrer" data-testid="launch-open">
                  <ExternalLink className="h-3.5 w-3.5" />
                  <Trans>Open the sandbox</Trans>
                </a>
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {declined ? <Trans>Nothing was launched. You can close this tab.</Trans> : <Trans>Preparing…</Trans>}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <>
      {body}
      <Dialog open={!started && !declined} onOpenChange={(o) => !o && setDeclined(true)}>
        <DialogContent className="sm:max-w-md" data-testid="launch-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
              <Trans>External link</Trans>
            </DialogTitle>
            <DialogDescription>
              {gitOrigin ? (
                <Trans>Would you like to launch a sandbox for this repository?</Trans>
              ) : (
                <Trans>This link doesn't name a repository we can launch.</Trans>
              )}
            </DialogDescription>
          </DialogHeader>

          {gitOrigin ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-start">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" data-testid="launch-repo">
                  {formatGitOrigin(gitOrigin)}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {gitOriginCloneUrl(gitOrigin)}
              </p>
            </div>
          ) : (
            <p className="break-all rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-start font-mono text-xs">
              {repo || t`(no repo given)`}
            </p>
          )}

          <DialogFooter className="mt-2">
            <Button variant="ghost" onClick={() => setDeclined(true)} data-testid="launch-cancel">
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={onLaunch} disabled={!gitOrigin} data-testid="launch-approve">
              <Trans>Launch sandbox</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
