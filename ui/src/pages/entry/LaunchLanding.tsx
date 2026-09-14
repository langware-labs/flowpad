import { cloudManager, gitOriginFromUrl } from '@sdk';
import { formatGitOrigin, gitOriginCloneUrl } from '@sdk/models/GitOrigin';
import { Button } from '@src/components/ui/button';
import { plannedSteps, useSandboxes } from '@src/hooks/use-sandboxes';
import { StepList } from '@src/components/ui/step-list';
import { ExternalLink, GitBranch, LogIn } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAuth } from '@sdk/react/hooks';

/** Where the approval survives the sign-in reload. */
const INTENT_KEY = 'flowpad_launch_intent';

/**
 * Remember that this repo was already approved, across a possible reload.
 *
 * The popup sign-in adopts the session in place (`refresh: 'session'`), so on the
 * happy path this page is never reloaded. It still can be: a blocked popup falls
 * back to a full-page redirect, and a failed in-place refresh falls back to
 * `location.reload()`. Without this, the user would approve a repository, sign
 * in, and be asked to approve the very same repository again — the second ask
 * carrying no information the first did not.
 *
 * `sessionStorage`, so it dies with the tab, and keyed by the RAW params rather
 * than the parsed origin: an approval is for one repo at one branch, and an
 * intent recorded for one link must never be spent launching another.
 */
function rememberLaunchIntent(repo: string, branch: string) {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ repo, branch }));
  } catch {
    // Private mode: the user gets the approve control a second time, which is
    // the pre-existing behaviour and not a failure.
  }
}

/** Consume the approval, if it was for THIS link. One-shot: cleared on read, so
 *  a reload can never spend it twice. */
function takeLaunchIntent(repo: string, branch: string): boolean {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { repo?: string; branch?: string };
    return saved?.repo === repo && saved?.branch === branch;
  } catch {
    return false;
  }
}

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
 * One of the few routes that RENDERS for a stranger (`routes/anonymous-entry.ts`):
 * it has to be able to show the repository before it can ask anyone to sign in
 * for it.
 *
 * ONE continuous card, not a modal that vanishes into an unrelated view. Every
 * phase — sign in, set the box up, open it — is visible from the FIRST paint as
 * one ordered `StepList`, unstarted rows sitting `idle` (grey, no action) the
 * same way `AgentDeployChecklist` gates deploy preconditions: the user sees the
 * whole journey before committing to any of it, and the one click that starts
 * it does not replace what they were just looking at — the repo card and the
 * row list stay exactly where they were, only the rows' own state moves.
 *
 * Phase 1 is a full-width button that never leaves its slot. Its label says
 * whether you are signed in — "Sign In" (opens the popup) or "Already signed
 * in, launch sandbox" (starts the pipeline) — and nothing else; whether it is
 * clickable says whether the launch has started. The two never mix, so greying
 * it out never changes what it says, and every phase keeps its place on the
 * card for the whole run. Signed out, approving is one click that both records the
 * approval and opens the sign-in popup — a popup needs the activation a click
 * carries, and it is the only sign-in that leaves the user on this URL.
 * Everything after it is the signed-in path, resumed once.
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

  // Once launching has started, the approve control is disabled for good — it
  // stays on the card as the completed phase 1, but a step that fails must leave
  // its error on the row, not re-arm a button that would start a second,
  // overlapping attempt.
  const [started, setStarted] = useState(false);
  const failed = steps.some((s) => s.status === 'error');

  // Reactive, because signing in no longer reloads this page: the session is
  // adopted in place, and `useAuth` re-renders on the CONTEXT_CHANGED that
  // brings the user in. `currentUser` is the cloud user, else the local one —
  // in hub mode both come from the bootstrap user (and `refreshSession` sets
  // both); in desk mode the local user keeps the meaning it had here before.
  const { currentUser } = useAuth();
  const signedIn = !!currentUser;

  const onLaunch = () => {
    if (!gitOrigin) return;
    setStarted(true);
    // Inside the click gesture — `launch` claims the new tab synchronously.
    // The hub sets the sandbox up (it holds the token, so a private repo works
    // here too) and the tab lands inside the project it created.
    void launch({ name, sandboxProject: { gitOrigin, name } });
  };

  /**
   * Approve and sign in, in one click.
   *
   * The click is load-bearing twice over: it records the approval, and it is the
   * transient activation `loginPopup` needs — a popup is the only sign-in that
   * leaves the user on this URL, and this URL's `?repo=` is the entire payload.
   * `cloudManager.login()` falls back to the full-page navigation when the popup
   * is blocked, and `resolveLoginCallbackUrl` has already recorded where to come
   * back to, so the blocked path still lands here.
   */
  const onSignInAndLaunch = () => {
    if (!gitOrigin) return;
    rememberLaunchIntent(repo, branch);
    // Opt in to the in-place refresh: `signedIn` flips true without a reload,
    // and the resume effect below starts the launch on this same mount.
    void cloudManager.login({ refresh: 'session' });
  };

  // Pick the approval back up once signed in — on this same mount after an
  // in-place refresh, or after a reload when one was the fallback. Not a
  // second consent: the user approved THIS repo one click ago, and re-asking
  // would be the app forgetting rather than the user reconsidering.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !signedIn || !gitOrigin || started) return;
    if (!takeLaunchIntent(repo, branch)) return;
    resumed.current = true;
    onLaunch();
    // `onLaunch` is stable for the life of this page (it reads state it also
    // sets, and the guard above makes it once-only), so the deps are the facts
    // that decide whether to resume, not the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, gitOrigin, started, repo, branch]);

  // Phase 2's rows. Live once a launch is under way; before that, the SAME
  // planner `useSandboxes` is about to call, so what the user is shown up front
  // can never drift from what actually runs.
  //
  // Keyed on `started`, NOT on `steps.length`: the hook seeds its own state with
  // `plannedSteps()` — no argument — which is the repo-less three-row stub
  // (`launch`, `health`, `open`). That is never empty, so a length test silently
  // pinned the preview to those three rows and the card jumped from three to
  // nine the moment it was clicked. `started` is the real question being asked
  // here: are these rows live yet, or still a plan?
  const setupSteps = started ? steps : gitOrigin ? plannedSteps({ gitOrigin, name }) : steps;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        {declined ? (
          <p className="text-center text-sm text-muted-foreground">
            <Trans>Nothing was launched. You can close this tab.</Trans>
          </p>
        ) : (
          <div className="rounded-lg border border-border p-5 text-start" data-testid="launch-panel">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
                <h1 className="text-sm font-semibold">
                  <Trans>External link</Trans>
                </h1>
              </div>
              {!started && (
                <Button variant="ghost" size="sm" onClick={() => setDeclined(true)} data-testid="launch-cancel">
                  <Trans>Cancel</Trans>
                </Button>
              )}
            </div>

            <p className="mb-3 text-xs text-muted-foreground">
              {!gitOrigin ? (
                <Trans>This link doesn't name a repository we can launch.</Trans>
              ) : started ? (
                launchUrl ? (
                  <Trans>Your sandbox is ready.</Trans>
                ) : failed ? (
                  <Trans>Couldn't finish preparing your sandbox.</Trans>
                ) : (
                  <Trans>Preparing your sandbox…</Trans>
                )
              ) : signedIn ? (
                <Trans>Launching runs the steps below against your account.</Trans>
              ) : (
                <Trans>
                  Signing in opens a window on top of this page — you stay right here — then runs the steps below.
                </Trans>
              )}
            </p>

            {gitOrigin ? (
              <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2.5">
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
              <p className="mb-4 break-all rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs">
                {repo || t`(no repo given)`}
              </p>
            )}

            {/* Phase 1: full-width like the phase 3 button, and permanent like
                it — present for the whole run, greyed rather than removed once
                the pipeline starts, so no phase ever vacates its slot. Disabled
                on `started`, which also guards against a second click starting
                an overlapping launch. The LABEL follows `signedIn` and
                only that, so greying never rewords it: a signed-in user's
                button stays "Already signed in, launch sandbox", greyed. After
                a popup sign-in `signedIn` flips true in place, so the label
                moves to the signed-in wording at the same moment the resume
                effect greys it — both now true. */}
            {gitOrigin && (
              <Button
                size="sm"
                onClick={signedIn ? onLaunch : onSignInAndLaunch}
                disabled={started}
                className="mb-3 w-full gap-1.5"
                data-testid="launch-approve"
              >
                {signedIn ? (
                  <Trans>Already signed in, launch sandbox</Trans>
                ) : (
                  <>
                    <LogIn className="h-3.5 w-3.5" />
                    <Trans>Sign In</Trans>
                  </>
                )}
              </Button>
            )}

            {/* Phase 2: every setup row visible from the very first paint —
                not revealed a piece at a time. An untouched row is already
                `idle` (grey, no checkmark), which is what makes "later phases
                wait for earlier ones" visible without a separate locked style. */}
            <StepList steps={setupSteps} testIdPrefix="launch" className="flex flex-col gap-1.5" />

            {/* Phase 3. Visible and disabled from the first paint too, same
                reasoning as every row above it: a control that only appears once
                it works reads as a surprise, not as the next step. */}
            {gitOrigin &&
              (launchUrl ? (
                <Button asChild size="sm" className="mt-3 w-full gap-1.5">
                  <a href={launchUrl} target="_blank" rel="noreferrer" data-testid="launch-open">
                    <ExternalLink className="h-3.5 w-3.5" />
                    <Trans>Open the sandbox</Trans>
                  </a>
                </Button>
              ) : (
                <Button size="sm" className="mt-3 w-full gap-1.5" disabled data-testid="launch-open-pending">
                  <ExternalLink className="h-3.5 w-3.5" />
                  <Trans>Open the sandbox</Trans>
                </Button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
