import { cloudManager, gitOriginCloneUrl, gitOriginFromUrl, isGitOrigin, type GitOrigin, type HubRepoOrigin, type Project } from '@sdk';
import { projectOriginOf } from '@sdk/models/FSOrigin';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Progress } from '@src/components/ui/progress';
import { useProjects } from '@src/hooks/use-projects';
import { type SandboxSetup, useSandboxes, workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { errorMessage } from '@src/lib/error-message';
import { CheckCircle, Cloud, Laptop, Loader2, LogIn } from 'lucide-react';
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
  const { info, loading, error } = useLaunchInfo(kind, linkId, signedIn);
  const tracker = useLaunchTracker(kind === 'agent' ? (linkId ?? undefined) : undefined, signedIn);
  const { createSandbox, launchSandbox, steps } = useSandboxes();
  useSetupStepTracking(tracker, steps);

  const isController = info?.subkind === 'controller';
  const { projects = [] } = useProjects({ enabled: signedIn && isController });
  const [pickedId, setPickedId] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [busy, setBusy] = useState<'cloud' | 'desktop' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

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

  // Launch in the cloud once per page: the sandbox is the work, and a second click must not
  // leave a second box behind.
  const startedCloud = useRef(false);
  const launchInCloud = async () => {
    if (!plan || !target || startedCloud.current) return;
    startedCloud.current = true;
    setBusy('cloud');
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
      const created = await createSandbox({ name: target.name, sandboxProject });
      const node = created ? await launchSandbox(created, { sandboxProject }) : null;
      if (!node) throw new Error(t`Couldn't set up the sandbox.`);
      tracker.setupComplete();
      tracker.enterMachine();
      // A top-level assign in THIS tab: a `window.open` minutes after the click is eaten by
      // popup blockers. The hub's `open-service` owns readiness, then lands on the plan.
      window.location.assign(workspaceServiceUrl(node.id, path));
    } catch (e) {
      tracker.setupError();
      setFailure(errorMessage(e, t`Couldn't set up the sandbox.`));
      setBusy(null);
    }
  };

  const launchOnDesktop = () => {
    if (!plan) return;
    setBusy('desktop');
    void openInFlowpad()
      .then((handedOff) => setFailure(handedOff ? null : t`FlowPad didn't open. Install it from flowpad.ai, then try again.`))
      .finally(() => setBusy(null));
  };

  // The hub answers "missing" and "not yours" alike (403), so the two read as one.
  const problem = error ? errorProblem(error) : null;
  const problemMessage =
    problem === 'unavailable'
      ? kind === 'agent'
        ? t`Can't launch this agent: it doesn't exist, or you don't have access to it.`
        : t`Can't launch this project: it doesn't exist, or you don't have access to it.`
      : problem === 'session-expired'
        ? t`Your session has expired. Sign in again to launch.`
        : problem === 'failed'
          ? errorMessage(error, t`Couldn't load what this link points at.`)
          : null;
  useEffect(() => {
    if (problem) tracker.agentError(problem);
  }, [problem, tracker]);

  const done = steps.filter((s) => s.status === 'success').length;
  const percent = steps.length ? Math.round((100 * done) / steps.length) : 0;
  // An agent link names the agent ("QA manager"), a project link its project.
  const name = (agent && (agent.getDisplayName() || agent.name)) || info?.project_name || '';
  const errorClass = 'mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs';

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
            <p className="text-sm font-medium" data-testid="launch-sign-in-title">
              {name ? (
                <Trans>Please sign in to start {name}…</Trans>
              ) : (
                <Trans>Please sign in to flowpad to continue.</Trans>
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

        {signedIn && loading && (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" data-testid="launch-agent-loading">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <Trans>Loading…</Trans>
          </p>
        )}

        {signedIn && problemMessage && (
          <p className={errorClass} data-testid="launch-agent-error">
            {problemMessage}
          </p>
        )}

        {signedIn && info && (
          <div className="mt-4 space-y-3" data-testid="launch-choice">
            <p className="text-sm font-medium" data-testid="launch-title">
              {isController ? <Trans>{name} works on another project. Which one?</Trans> : <Trans>Launch {name}</Trans>}
            </p>

            {isController && (
              <div className="space-y-2" data-testid="launch-target-picker">
                <select
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  value={pickedId}
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
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                    if (e.target.value) setPickedId('');
                  }}
                  placeholder={t`…or a repository URL`}
                  className="text-sm"
                  data-testid="launch-target-repo"
                />
              </div>
            )}

            <div className="flex gap-2">
              <Button
                className="flex-1 gap-1.5"
                disabled={!plan || busy !== null}
                onClick={launchOnDesktop}
                data-testid="launch-desktop"
              >
                <Laptop className="h-4 w-4" />
                <Trans>Launch in my desktop</Trans>
              </Button>
              <Button
                variant="outline"
                className="flex-1 gap-1.5"
                disabled={!plan || busy !== null}
                onClick={() => void launchInCloud()}
                data-testid="launch-cloud"
              >
                <Cloud className="h-4 w-4" />
                <Trans>Launch in cloud</Trans>
              </Button>
            </div>
          </div>
        )}

        {busy === 'cloud' && !failure && (
          <div className="mt-5 flex flex-col items-center gap-3 text-center" data-testid="launch-setting-up">
            <p className="text-sm font-medium">
              <Trans>Setting up {name} on a new sandbox…</Trans>
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
