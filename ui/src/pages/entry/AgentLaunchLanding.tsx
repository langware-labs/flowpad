import {
  cloudManager,
  type ComputeNode,
  gitOriginCloneUrl,
  gitOriginFromUrl,
  isGitOrigin,
  type GitOrigin,
  type HubRepoOrigin,
  type Project,
} from '@sdk';
import { projectOriginOf } from '@sdk/models/FSOrigin';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Progress } from '@src/components/ui/progress';
import { useProjects } from '@src/hooks/use-projects';
import { type SandboxSetup, useSandboxes, workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { errorMessage, isMissingGitCredential } from '@src/lib/error-message';
import { CheckCircle, Cloud, Laptop, Loader2, LogIn } from 'lucide-react';
import { RuntimeStrip } from '@src/components/top-nav-bar/RuntimeStrip';
import { StepList } from '@src/components/ui/step-list';
import { refreshSession } from '@sdk/session-refresh';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAuth } from '@sdk/react/hooks';
import { useLaunchTracker, useSetupStepTracking } from './launch-analytics';
import { type LaunchInfo, useLaunchInfo } from './launch-info';
import { type LaunchPlan, launchPlanToPath } from './launch-plan';
import { errorProblem, useLaunchTarget } from './launch-target';
import { useOpenInFlowpad } from './useOpenFlowpad';

/** What the picked (or linked) target is checked out from, for the cloud leg. */
interface TargetChoice {
  plan: LaunchPlan['target'];
  name: string;
  origin: GitOrigin | HubRepoOrigin | null;
}

/** A controller's target: the picked project, else the typed repository URL, else none yet. */
function pickedTarget(candidates: Project[], pickedId: string, repoUrl: string): TargetChoice | null {
  const picked = candidates.find((p) => p.id === pickedId);
  if (picked) return { plan: { projectId: picked.id }, name: picked.name ?? '', origin: projectOriginOf(picked) };
  const origin = repoUrl.trim() ? gitOriginFromUrl(repoUrl.trim()) : null;
  return origin ? { plan: { repo: repoUrl.trim() }, name: origin.name, origin } : null;
}

/** A link's own project as the target: by its hub id, else by its repository. */
function ownTarget(info: LaunchInfo): TargetChoice | null {
  if (info.project_id) return { plan: { projectId: info.project_id }, name: info.project_name, origin: info.origin };
  if (info.origin && isGitOrigin(info.origin)) {
    const repo = gitOriginCloneUrl(info.origin);
    return { plan: { repo, branch: info.origin.branch || undefined }, name: info.origin.name, origin: info.origin };
  }
  return null;
}

/**
 * `/launch?agent=<id>` or `/launch?project=<id>` — the USE stage of a launch link, on the hub.
 *
 * It ends by handing one machine a `LaunchPlan` (`launch-plan.ts`), and does nothing else:
 *   1. Sign in (the only click before the choice).
 *   2. Ask the hub what the link names (`launch_info`): its project, where that is checked
 *      out from, and its subkind. A `controller` is used to work on ANOTHER project, so
 *      the person picks that target here — one of their projects, or a repository.
 *   3. Launch in my desktop — the `flowpad://` deep link carries the plan's path — or in
 *      the cloud: a new sandbox is provisioned with the target and, beside it, the
 *      controller (never attached), then this tab goes to the box on the plan's path.
 * Either way the machine runs the same SETUP (`action=launch`, `LaunchDialog`).
 *
 * Every state says what it is waiting for or what is wrong: a launch button is never
 * disabled without the reason written under it, and a failure always leaves a way on.
 *
 * Signed out, a quiet anonymous read still names a PUBLIC agent on the sign-in card.
 * Every stage reports to the GA4 launch funnel (`launch-analytics.ts`).
 */
export default function AgentLaunchLanding({ params }: { params: URLSearchParams }) {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const signedIn = !!currentUser;
  const { target: link, agent } = useLaunchTarget(params, signedIn);
  const kind = link.kind === 'project' ? 'project' : 'agent';
  const linkId = link.kind === 'project' ? link.projectId : link.kind === 'agent' ? link.agentTypeId.id : null;
  const { info, loading, error, reload } = useLaunchInfo(kind, linkId, signedIn);
  const tracker = useLaunchTracker(kind === 'agent' ? (linkId ?? undefined) : undefined, signedIn);
  const { createSandbox, launchSandbox, provisionProject, steps } = useSandboxes();
  useSetupStepTracking(tracker, steps);

  const isController = info?.subkind === 'controller';
  const { projects = [] } = useProjects({ enabled: signedIn && isController });
  const [pickedId, setPickedId] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [cloud, setCloud] = useState<'idle' | 'running' | 'failed'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<'idle' | 'opening' | 'waiting'>('idle');
  const [signInDropped, setSignInDropped] = useState(false);

  // The controller is never offered as its own target, and a target needs somewhere to clone from.
  const candidates = projects.filter((p) => p.id !== info?.project_id && projectOriginOf(p));
  const target = info ? (isController ? pickedTarget(candidates, pickedId, repoUrl) : ownTarget(info)) : null;
  // A controller is launched by its hub id; one without a hub project has nothing to check out.
  const controllerId = isController ? info?.project_id : undefined;
  const plan: LaunchPlan | null =
    target && (!isController || controllerId)
      ? {
          target: target.plan,
          ...(controllerId ? { controllerId } : {}),
          ...(kind === 'agent' && linkId ? { agentId: linkId } : {}),
        }
      : null;

  const path = plan ? launchPlanToPath(plan) : '';
  const openInFlowpad = useOpenInFlowpad(path);

  const signIn = async () => {
    tracker.signInStart();
    setSignInDropped(false);
    const outcome = await cloudManager.loginPopup({ refresh: 'session' });
    // No popup to be had: the ordinary full-page sign-in, which comes back to this link.
    if (outcome === 'blocked') return void cloudManager.login({ popup: false });
    // A popup that ended anywhere but its own done page reads as closed even when the sign-in
    // went through, so the session is asked before the person is told it did not.
    if (outcome === 'cancelled' && !(await refreshSession())) setSignInDropped(true);
    reload();
  };

  // One sandbox per page: the box is the work, so a retry carries on with the one already made
  // rather than leaving a second behind.
  const sandbox = useRef<ComputeNode | null>(null);
  const cloudRunning = useRef(false);
  const boxIsUp = steps.some((s) => s.id === 'health' && s.status === 'success');
  const launchInCloud = async () => {
    if (!plan || !target || cloudRunning.current) return;
    cloudRunning.current = true;
    setCloud('running');
    setFailure(null);
    tracker.setupStart();
    const sandboxProject: SandboxSetup = {
      name: target.name,
      ...(target.origin ? { gitOrigin: target.origin } : {}),
      ...('projectId' in target.plan ? { projectId: target.plan.projectId } : {}),
      ...(controllerId && info?.origin
        ? { companions: [{ gitOrigin: info.origin, name: info.project_name, projectId: controllerId }] }
        : {}),
    };
    try {
      // A box that came up keeps its machine: only the project work is redone on it.
      const redoProject = sandbox.current !== null && boxIsUp;
      sandbox.current ??= await createSandbox({ name: target.name, sandboxProject });
      const made = sandbox.current;
      const node = made ? await (redoProject ? provisionProject(made) : launchSandbox(made, { sandboxProject })) : null;
      if (!node) throw new Error(t`Couldn't set up the sandbox.`);
      tracker.setupComplete();
      tracker.enterMachine();
      // A top-level assign in THIS tab: a `window.open` minutes after the click is eaten by
      // popup blockers. The hub's `open-service` owns readiness, then lands on the plan.
      window.location.assign(workspaceServiceUrl(node.id, path));
    } catch (e) {
      tracker.setupError();
      // Git's own words for a clone with no credentials are about a terminal prompt; what happened
      // is a repository this account cannot read.
      setFailure(
        isMissingGitCredential(e)
          ? t`Couldn't clone that repository: it doesn't exist, or it is private and GitHub isn't connected to your account.`
          : errorMessage(e, t`Couldn't set up the sandbox.`),
      );
      setCloud('failed');
    } finally {
      cloudRunning.current = false;
    }
  };

  // The browser asks before it hands a link to an app, and takes as long as the person does:
  // the page waits for that, and never decides for them that nothing opened.
  const launchOnDesktop = () => {
    if (!plan) return;
    setDesktop('opening');
    void openInFlowpad().finally(() => setDesktop('waiting'));
  };

  // The hub answers "missing" and "not yours" alike (403), so the two read as one.
  const problem = error ? errorProblem(error) : null;
  const signedOut = !signedIn || problem === 'session-expired';
  const account = currentUser?.email || currentUser?.name || '';
  const problemMessage =
    problem === 'unavailable'
      ? kind === 'agent'
        ? t`Can't launch this agent: it doesn't exist, or you don't have access to it.`
        : t`Can't launch this project: it doesn't exist, or you don't have access to it.`
      : problem === 'failed'
        ? t`Couldn't load what this link points at.`
        : !signedOut && !loading && !info
          ? t`This link has nothing to launch.`
          : null;
  useEffect(() => {
    if (problem) tracker.agentError(problem);
  }, [problem, tracker]);

  const done = steps.filter((s) => s.status === 'success').length;
  const percent = steps.length ? Math.round((100 * done) / steps.length) : 0;
  // An agent link names the agent ("QA manager"), a project link its project.
  const name = (agent && (agent.getDisplayName() || agent.name)) || info?.project_name || '';
  // Viewable, but its project's files are not shared with this person: neither machine could
  // check it out, so it is said here instead of after a refused clone.
  const notShared = info?.project_shared === false;
  // Nothing to check out: the owner never published the project behind this link.
  const unpublished = !!info && !notShared && (isController ? !controllerId : !ownTarget(info));
  // Why a controller cannot be launched yet — said under the picker, never left to a grey button.
  const pickerHint =
    !isController || plan || unpublished
      ? null
      : repoUrl.trim()
        ? t`That isn't a repository URL.`
        : candidates.length
          ? t`Pick the project it should work on, or paste a repository URL.`
          : t`You have no projects here yet. Paste a repository URL.`;
  const locked = cloud !== 'idle';
  const errorClass = 'mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <RuntimeStrip />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border p-5 text-start" data-testid="launch-panel">
          {signedOut ? (
            <div className="flex flex-col items-center gap-3 text-center" data-testid="launch-sign-in-card">
              <p className="text-sm font-medium" data-testid="launch-sign-in-title">
                {problem === 'session-expired' ? (
                  <Trans>Your session has expired. Sign in again to launch.</Trans>
                ) : name ? (
                  <Trans>Please sign in to start {name}…</Trans>
                ) : (
                  <Trans>Please sign in to flowpad to continue.</Trans>
                )}
              </p>
              <Button size="sm" onClick={() => void signIn()} className="w-full gap-1.5" data-testid="launch-sign-in">
                <LogIn className="h-3.5 w-3.5" />
                <Trans>Sign In</Trans>
              </Button>
              {signInDropped && (
                <p className="text-xs text-muted-foreground" data-testid="launch-sign-in-dropped">
                  <Trans>Sign-in wasn't completed. Try again when you're ready.</Trans>
                </p>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm" data-testid="launch-signed-in">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <Trans>Signed in</Trans>
            </p>
          )}

          {!signedOut && loading && (
            <p
              className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="launch-agent-loading"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <Trans>Loading…</Trans>
            </p>
          )}

          {!signedOut && problemMessage && (
            <div className={errorClass} data-testid="launch-agent-error">
              <p>{problemMessage}</p>
              {problem === 'unavailable' && account && (
                <p className="mt-1 text-muted-foreground" data-testid="launch-account">
                  <Trans>You are signed in as {account}.</Trans>
                </p>
              )}
              {problem === 'failed' && (
                <Button variant="outline" size="sm" className="mt-2" onClick={reload} data-testid="launch-reload">
                  <Trans>Try again</Trans>
                </Button>
              )}
            </div>
          )}

          {!signedOut && info && unpublished && (
            <p className={errorClass} data-testid="launch-unpublished">
              {name ? (
                <Trans>{name} isn't published yet. Ask its owner to publish it, then open this link again.</Trans>
              ) : (
                <Trans>This isn't published yet. Ask its owner to publish it, then open this link again.</Trans>
              )}
            </p>
          )}

          {!signedOut && info && notShared && (
            <div className={errorClass} data-testid="launch-not-shared">
              <p>
                {name ? (
                  <Trans>You can see {name}, but its project isn't shared with you, so it can't be launched.</Trans>
                ) : (
                  <Trans>This project isn't shared with you, so it can't be launched.</Trans>
                )}
              </p>
              <p className="mt-1 text-muted-foreground">
                <Trans>Ask its owner to share the project with {account || t`your account`}.</Trans>
              </p>
            </div>
          )}

          {!signedOut && info && !unpublished && !notShared && (
            <div className="mt-4 space-y-3" data-testid="launch-choice">
              <p className="text-sm font-medium" data-testid="launch-title">
                {isController ? (
                  <Trans>{name} works on another project. Which one?</Trans>
                ) : (
                  <Trans>Launch {name}</Trans>
                )}
              </p>

              {isController && (
                <div className="space-y-2" data-testid="launch-target-picker">
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    value={pickedId}
                    disabled={locked}
                    onChange={(e) => {
                      setPickedId(e.target.value);
                      if (e.target.value) setRepoUrl('');
                    }}
                    data-testid="launch-target-select"
                  >
                    <option value="">{t`Pick one of your projects…`}</option>
                    {candidates.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={repoUrl}
                    disabled={locked}
                    onChange={(e) => {
                      setRepoUrl(e.target.value);
                      if (e.target.value) setPickedId('');
                    }}
                    placeholder={t`…or a repository URL`}
                    className="text-sm"
                    data-testid="launch-target-repo"
                  />
                  {pickerHint && (
                    <p className="text-xs text-muted-foreground" data-testid="launch-hint">
                      {pickerHint}
                    </p>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  className="flex-1 gap-1.5"
                  disabled={!plan || locked || desktop === 'opening'}
                  onClick={launchOnDesktop}
                  data-testid="launch-desktop"
                >
                  <Laptop className="h-4 w-4" />
                  <Trans>Launch in my desktop</Trans>
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 gap-1.5"
                  disabled={!plan || locked || desktop === 'opening'}
                  onClick={() => void launchInCloud()}
                  data-testid="launch-cloud"
                >
                  <Cloud className="h-4 w-4" />
                  <Trans>Launch in cloud</Trans>
                </Button>
              </div>
            </div>
          )}

          {desktop === 'waiting' && cloud === 'idle' && (
            <div
              className="mt-4 space-y-2 rounded-md border border-border px-3 py-2 text-xs"
              data-testid="launch-desktop-waiting"
            >
              <p className="font-medium">
                <Trans>Waiting for FlowPad to open…</Trans>
              </p>
              <p className="text-muted-foreground">
                <Trans>If your browser asks, choose Open. FlowPad then carries on from here.</Trans>
              </p>
              <p className="text-muted-foreground">
                <button
                  type="button"
                  className="underline"
                  onClick={launchOnDesktop}
                  data-testid="launch-desktop-again"
                >
                  <Trans>Open again</Trans>
                </button>
                {' · '}
                <Trans>Don't have FlowPad yet?</Trans>{' '}
                <a
                  className="underline"
                  href="https://flowpad.ai/"
                  target="_blank"
                  rel="noreferrer"
                  data-testid="launch-get-flowpad"
                >
                  <Trans>Get it at flowpad.ai</Trans>
                </a>
              </p>
            </div>
          )}

          {cloud !== 'idle' && (
            <div className="mt-5 space-y-3" data-testid="launch-setting-up">
              <p className="text-center text-sm font-medium">
                {cloud === 'failed' ? (
                  <Trans>Couldn't finish setting up the sandbox.</Trans>
                ) : (
                  <Trans>Setting up {name} on a new sandbox…</Trans>
                )}
              </p>
              {cloud === 'running' && (
                <>
                  <Progress value={percent} className="w-full" data-testid="launch-progress" />
                  <p className="text-center text-xs tabular-nums text-muted-foreground" data-testid="launch-percent">
                    {percent}%
                  </p>
                </>
              )}
              <StepList steps={steps} testIdPrefix="launch" />
            </div>
          )}

          {cloud === 'failed' && (
            <div className={errorClass} data-testid="launch-failed">
              <p>{failure}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void launchInCloud()}
                  data-testid="launch-cloud-retry"
                >
                  <Trans>Try again</Trans>
                </Button>
                {boxIsUp && sandbox.current && (
                  <a
                    className="underline"
                    href={workspaceServiceUrl(sandbox.current.id)}
                    data-testid="launch-open-sandbox"
                  >
                    <Trans>Open the sandbox as it is</Trans>
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
