import { cloudManager } from '@sdk';
import { formatGitOrigin, gitOriginCloneUrl } from '@sdk/models/GitOrigin';
import { Button } from '@src/components/ui/button';
import { plannedSteps, useSandboxes } from '@src/hooks/use-sandboxes';
import { StepList } from '@src/components/ui/step-list';
import { ExternalLink, GitBranch, LogIn } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAuth } from '@sdk/react/hooks';
import AgentLaunchLanding from './AgentLaunchLanding';
import { parseLaunchParams, useLaunchTarget } from './launch-target';

/** Where the approval survives the sign-in reload. */
const INTENT_KEY = 'flowpad_launch_intent';

/**
 * The link an approval is for: every query param that decides WHAT launches.
 *
 * Keyed by the RAW params rather than the parsed origin: an approval is for one repo at one
 * branch, and an intent recorded for one link must never be spent launching another.
 */
function linkIdentity(params: URLSearchParams): string {
  return JSON.stringify({
    repo: params.get('repo') ?? '',
    branch: params.get('branch') ?? '',
    agent: params.get('agent') ?? '',
  });
}

/**
 * Remember that this link was already approved, across a possible reload.
 *
 * The popup sign-in adopts the session in place (`refresh: 'session'`), so on the
 * happy path this page is never reloaded. It still can be: a blocked popup falls
 * back to a full-page redirect, and a failed in-place refresh falls back to
 * `location.reload()`. Without this, the user would approve a repository, sign
 * in, and be asked to approve the very same repository again — the second ask
 * carrying no information the first did not.
 *
 * `sessionStorage`, so it dies with the tab.
 */
function rememberLaunchIntent(link: string) {
  try {
    sessionStorage.setItem(INTENT_KEY, link);
  } catch {
    // Private mode: the user gets the approve control a second time, which is
    // the pre-existing behaviour and not a failure.
  }
}

/** Consume the approval, if it was for THIS link. One-shot: cleared on read, so
 *  a reload can never spend it twice. */
function takeLaunchIntent(link: string): boolean {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    return raw === link;
  } catch {
    return false;
  }
}

/**
 * `/launch?repo=<git url>` or `/launch?agent=<agent id>` — the one-click entry point
 * for "try this repo" / "try this agent".
 *
 * The two are different pages behind one route. An agent link goes to
 * `AgentLaunchLanding`: sign in, then straight into a sandbox, no approve step.
 * Everything else — a repo link, and a link that is not valid as either — stays on
 * the repo card below. Decided from the raw query (`parseLaunchParams`), before any
 * hook that only one of the two pages needs.
 */
export default function LaunchLanding() {
  const [params] = useSearchParams();
  return parseLaunchParams(params).kind === 'agent' ? <AgentLaunchLanding params={params} /> : <RepoLaunchLanding />;
}

/**
 * `/launch?repo=<git url>` — "try this repo".
 *
 * A link anyone can share: opening it lands here, and because the link came
 * from OUTSIDE the app, launching a cloud sandbox on its say-so is never
 * automatic — the repo is spelled out and the user approves it. On approve we
 * run the SAME pipeline the New Sandbox dialog does (`useSandboxes().launch`):
 * create the box → wait for FlowPad + sign-in → open it ON its clone landing,
 * where the box clones the repo into a fresh indexed Project. The repo's own
 * auto-launch journey then greets the user inside.
 *
 * A link naming both `repo` and `agent`, or an `agent` that is not an agent id,
 * lands here too and is refused.
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
 * card for the whole run. Signed out, approving is one click that both records
 * the approval and opens the sign-in popup — a popup needs the activation a
 * click carries, and it is the only sign-in that leaves the user on this URL.
 * Everything after it is the signed-in path, resumed once.
 *
 * `?name=` overrides the project/desktop name, `?branch=` the branch.
 */
function RepoLaunchLanding() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const { launch, steps, launchUrl } = useSandboxes();
  const [declined, setDeclined] = useState(false);

  // Reactive, because signing in no longer reloads this page: the session is
  // adopted in place, and `useAuth` re-renders on the CONTEXT_CHANGED that
  // brings the user in. `currentUser` is the cloud user, else the local one —
  // in hub mode both come from the bootstrap user (and `refreshSession` sets
  // both); in desk mode the local user keeps the meaning it had here before.
  const { currentUser } = useAuth();
  const signedIn = !!currentUser;

  const { target, gitOrigin } = useLaunchTarget(params, signedIn);
  const name = (params.get('name') || gitOrigin?.name || '').trim();
  const link = useMemo(() => linkIdentity(params), [params]);

  // Once launching has started, the approve control is disabled for good — it
  // stays on the card as the completed phase 1, but a step that fails must leave
  // its error on the row, not re-arm a button that would start a second,
  // overlapping attempt.
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

  /**
   * Approve and sign in, in one click.
   *
   * The click is load-bearing twice over: it records the approval (the repository
   * is already on the card), and it is the transient activation `loginPopup` needs
   * — a popup is the only sign-in that leaves the user on this URL, and this URL's
   * query is the entire payload. `cloudManager.login()` falls back to the full-page
   * navigation when the popup is blocked, and `resolveLoginCallbackUrl` has already
   * recorded where to come back to, so the blocked path still lands here.
   */
  const onSignIn = () => {
    if (target.kind === 'repo' && gitOrigin) rememberLaunchIntent(link);
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
    if (resumed.current || !signedIn || !gitOrigin || started || target.kind !== 'repo') return;
    if (!takeLaunchIntent(link)) return;
    resumed.current = true;
    onLaunch();
    // `onLaunch` is stable for the life of this page (it reads state it also
    // sets, and the guard above makes it once-only), so the deps are the facts
    // that decide whether to resume, not the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, gitOrigin, started, target.kind, link]);

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
  //
  // A refused link has no plan to preview, so it shows none rather than the stub.
  const setupSteps = started
    ? steps
    : gitOrigin
      ? plannedSteps({ gitOrigin, name })
      : target.kind === 'repo' || (target.kind === 'invalid' && target.reason === 'none')
        ? steps
        : null;

  const showApprove = target.kind === 'repo' && !!gitOrigin;

  const invalidMessage =
    target.kind === 'invalid' && target.reason === 'both'
      ? t`This link names both a repository and an agent. Ask for a link that names just one.`
      : target.kind === 'invalid' && target.reason === 'bad-agent-id'
        ? t`This link doesn't point at an agent.`
        : null;

  let description: ReactNode = null;
  if (invalidMessage) {
    description = null;
  } else if (!gitOrigin) {
    description = <Trans>This link doesn't name a repository we can launch.</Trans>;
  } else if (started) {
    description = launchUrl ? (
      <Trans>Your sandbox is ready.</Trans>
    ) : failed ? (
      <Trans>Couldn't finish preparing your sandbox.</Trans>
    ) : (
      <Trans>Preparing your sandbox…</Trans>
    );
  } else if (signedIn) {
    description = <Trans>Launching runs the steps below against your account.</Trans>;
  } else {
    description = (
      <Trans>Signing in opens a window on top of this page — you stay right here — then runs the steps below.</Trans>
    );
  }

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

            {description && <p className="mb-3 text-xs text-muted-foreground">{description}</p>}

            {invalidMessage && (
              <p
                className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
                data-testid="launch-invalid-link"
              >
                {invalidMessage}
              </p>
            )}

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
              !invalidMessage && (
                <p className="mb-4 break-all rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs">
                  {params.get('repo') || t`(no repo given)`}
                </p>
              )
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
            {showApprove && (
              <Button
                size="sm"
                onClick={signedIn ? onLaunch : onSignIn}
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
            {setupSteps && <StepList steps={setupSteps} testIdPrefix="launch" className="flex flex-col gap-1.5" />}

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
