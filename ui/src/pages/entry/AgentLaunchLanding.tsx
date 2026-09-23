import { cloudManager } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Progress } from '@src/components/ui/progress';
import { useSandboxes, workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { errorMessage } from '@src/lib/error-message';
import { CheckCircle, Loader2, LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAuth } from '@sdk/react/hooks';
import { useLaunchTracker, useSetupStepTracking } from './launch-analytics';
import { useLaunchTarget } from './launch-target';

/**
 * `/launch?agent=<agent id>` — straight into a sandbox running the agent.
 *
 * Two things on the card and nothing else: sign-in, then the setup. Signing in is
 * the only click. Once there is a session the agent is read from the hub, and the
 * moment its repository is known the sandbox is created, launched and opened — no
 * approve step, because the link names an agent the user can already see (the read
 * is refused otherwise), not a URL they have never been shown.
 *
 * Signed out, the page still tries a quiet anonymous read: a PUBLIC agent answers it,
 * so the sign-in card can name the agent it is for. A private one does not, and that is
 * expected — the card falls back to the generic sign-in line, no error.
 *
 * Opened with a top-level `assign` in THIS tab, not `useSandboxes().launch`: that
 * one ends in `window.open`, which a popup blocker eats once the click that started
 * it is minutes behind, and would leave this tab spinning next to the new one.
 * Same redirect `OpenSandboxLanding` makes: the hub's `open-service` owns readiness.
 *
 * `?name=` overrides the project name, as on a repo link.
 *
 * Every stage reports to the GA4 launch funnel (`launch-analytics.ts`).
 */
export default function AgentLaunchLanding({ params }: { params: URLSearchParams }) {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const signedIn = !!currentUser;
  const { gitOrigin, agent, agentLoading, agentProblem, agentError } = useLaunchTarget(params, signedIn);
  const { createSandbox, launchSandbox, steps } = useSandboxes();
  const [failure, setFailure] = useState<string | null>(null);
  const tracker = useLaunchTracker(params.get('agent')?.trim() || undefined, signedIn);
  useSetupStepTracking(tracker, steps);

  // Share of the setup rows `launchSandbox` has finished. Whole steps only: a row in
  // flight counts for nothing, so the number never claims work that has not landed.
  const done = steps.filter((s) => s.status === 'success').length;
  const percent = steps.length ? Math.round((100 * done) / steps.length) : 0;

  const agentName = agent ? agent.getDisplayName() || agent.name || '' : '';
  const name = (params.get('name') || gitOrigin?.name || '').trim();

  // Once per page. A ref, not state: the launch must not re-run when the agent row
  // refreshes in place or StrictMode replays the effect, and nothing renders off it.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !signedIn || !gitOrigin) return;
    started.current = true;
    const sandboxProject = { gitOrigin, name };
    tracker.setupStart();
    void (async () => {
      try {
        const created = await createSandbox({ name, sandboxProject });
        const node = created ? await launchSandbox(created, { sandboxProject }) : null;
        if (!node) throw new Error(t`Couldn't set up the sandbox.`);
        tracker.setupComplete();
        tracker.enterMachine();
        window.location.assign(workspaceServiceUrl(node.id));
      } catch (e) {
        tracker.setupError();
        setFailure(errorMessage(e, t`Couldn't set up the sandbox.`));
      }
    })();
  }, [signedIn, gitOrigin, name, createSandbox, launchSandbox, t, tracker]);

  const agentProblemMessage =
    agentProblem === 'unavailable'
      ? t`Can't launch this agent: it doesn't exist, or you don't have access to it.`
      : agentProblem === 'session-expired'
        ? t`Your session has expired. Sign in again to open this agent.`
        : agentProblem === 'failed'
          ? errorMessage(agentError, t`Couldn't load this agent.`)
          : null;

  // A link that can't be launched ends the funnel here; reported once per distinct problem.
  const agentErrorReason = agentProblem ?? (signedIn && agent && !gitOrigin ? 'no-repo' : null);
  useEffect(() => {
    if (agentErrorReason) tracker.agentError(agentErrorReason);
  }, [agentErrorReason, tracker]);

  const errorClass = 'mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs';
  // One title style for both halves of the page: signing in changes the words, nothing else.
  const titleClass = 'text-sm font-medium';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border p-5 text-start" data-testid="launch-panel">
        {signedIn ? (
          <p className="flex items-center gap-2 text-sm" data-testid="launch-signed-in">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <Trans>Signed in</Trans>
          </p>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center" data-testid="launch-sign-in-card">
            <p className={titleClass} data-testid="launch-sign-in-title">
              {agent ? (
                <Trans>Please sign in to start the agent {agentName}…</Trans>
              ) : (
                <Trans>Please sign in to flowpad to continue with the agent creation process.</Trans>
              )}
            </p>
            <Button
              size="sm"
              onClick={() => {
                tracker.signInStart();
                void cloudManager.login({ refresh: 'session' });
              }}
              className="w-full gap-1.5"
              data-testid="launch-sign-in"
            >
              <LogIn className="h-3.5 w-3.5" />
              <Trans>Sign In</Trans>
            </Button>
          </div>
        )}

        {signedIn && agentLoading && (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" data-testid="launch-agent-loading">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <Trans>Loading the agent…</Trans>
          </p>
        )}

        {agentProblemMessage && (
          <p className={errorClass} data-testid="launch-agent-error">
            {agentProblemMessage}
          </p>
        )}

        {signedIn && agent && !gitOrigin && (
          <p className={errorClass} data-testid="launch-agent-no-repo">
            <Trans>This agent isn't published from a git repository, so there's nothing to launch.</Trans>
          </p>
        )}

        {signedIn && gitOrigin && !failure && (
          <div className="mt-5 flex flex-col items-center gap-3 text-center" data-testid="launch-setting-up">
            <p className={titleClass}>
              <Trans>Setting up your {agentName} on a new sandbox…</Trans>
            </p>
            <Progress value={percent} className="w-full" data-testid="launch-progress" />
            <p className="text-xs tabular-nums text-muted-foreground" data-testid="launch-percent">
              {percent}%
            </p>
          </div>
        )}

        {failure && (
          <p className={errorClass} data-testid="launch-failed">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
}
