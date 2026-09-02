import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { OAUTH_PROVIDERS, OAuthStatus, launchWizard, oauthService, type Agent } from '@sdk';
import { useOAuthFlowComplete, useProject } from '@sdk/react/hooks';

import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import { ProjectPublishButton } from '@src/components/project-home/ProjectPublishButton';
import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useGitPush } from '@src/hooks/use-git-push';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { errorMessage } from '@src/lib/error-message';
import { fetchGithubStatus } from '@src/lib/github-oauth-status';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { notify } from '@src/notifications';
import type { Step, StepStatus } from '@src/hooks/use-step-flow';

import {
  DEPLOY_STEP_IDS,
  deployBlocker,
  deployReadiness,
  deployReadyState,
  type DeployStepId,
  type DeployStepState,
} from './deploy-readiness';

interface AgentDeployChecklistProps {
  agent: Agent;
  /**
   * Tri-state readiness for the host's Deploy button. `null` means "still
   * checking" and must NOT disable it — see `deployReadyState`.
   */
  onReadinessChange?: (ready: boolean | null) => void;
}

const STEP_STATUS: Record<DeployStepState, StepStatus> = {
  done: 'success',
  checking: 'loading',
  todo: 'idle',
  pending: 'idle',
  blocked: 'error',
};

/**
 * What still has to happen before this agent can be deployed to the cloud.
 *
 * Deploy used to be a leap of faith: its only gate was `agent.enabled`, and
 * every real precondition was enforced server-side and reported as a red toast
 * after the round trip. This asks the same gates BEFORE the click, and gives the
 * first unmet one the button that fixes it.
 *
 * Nothing here decides anything about git. `git_share_preflight` is the
 * authoritative verdict — the frontend never shells git — and
 * `deploy-readiness.ts` owns the mapping; this component only asks the questions
 * and renders the answers. Every remediation is a seam the Project "Link to
 * cloud" button already uses, so the two paths cannot drift.
 *
 * Re-checks are EVENT-driven: each remediation re-asks once, when it settles.
 * No interval, no polling, no retry budget.
 */
export function AgentDeployChecklist({ agent, onReadinessChange }: AgentDeployChecklistProps) {
  const { t } = useLingui();
  const hubMode = isHubOnly();

  const cloudAuthed = useCloudAuthed();
  const { project } = useProject();
  const preflight = useGitSharePreflight(agent.typeId, !hubMode);
  const requireCloudLogin = useCloudLoginGate();

  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);

  const projectMount = project?.fs_storage_mount_path ?? null;
  const projectPublished = project ? project.remote === true : null;

  /**
   * `fetchGithubStatus` answers `null` when it could not ask at all — typically
   * before the local user is resolved. Kept as `null` (a row that reads
   * "checking") rather than coerced to "not connected": a probe that failed is
   * not evidence of a missing grant, and `deployReadyState` leaves Deploy
   * enabled on it rather than taking away a button that works.
   */
  const probeGithub = useCallback(async () => {
    setGithubConnected(await fetchGithubStatus());
  }, []);

  // Re-asked when the cloud login lands: that is when the user becomes
  // resolvable, so a previously unanswerable probe can finally answer.
  useEffect(() => {
    if (hubMode) return;
    void probeGithub();
  }, [hubMode, probeGithub, cloudAuthed]);

  const { push, busy: pushBusy } = useGitPush('@local', projectMount, preflight.refetch);

  const states = useMemo(
    () =>
      deployReadiness({
        cloudAuthed,
        githubConnected,
        projectPublished,
        preflight: {
          answered: preflight.answered,
          loading: preflight.loading,
          code: preflight.code,
        },
      }),
    [cloudAuthed, githubConnected, projectPublished, preflight.answered, preflight.loading, preflight.code],
  );

  const ready = deployReadyState(states);
  useEffect(() => {
    onReadinessChange?.(ready);
  }, [ready, onReadinessChange]);

  const runLogin = useCallback(async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    try {
      const login = await requireCloudLogin();
      if (!login.ok) {
        notify.error({ title: t`Could not sign in to the cloud`, message: login.error, forceToast: true });
        return;
      }
      // The login resolves the user, which is what makes the GitHub probe answerable.
      await probeGithub();
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy, probeGithub, requireCloudLogin, t]);

  // Subscribed only while THIS component's connect is pending, so an abandoned
  // flow leaves no listener behind and someone else's connect can't re-probe here.
  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (message) => {
      setOauthConnecting(false);
      if (message.status !== OAuthStatus.SUCCESS) {
        notify.error({
          title: t`Could not connect GitHub`,
          message: t`GitHub authorization did not complete.`,
          forceToast: true,
        });
      }
      void probeGithub();
    },
    oauthConnecting,
  );

  const connectGitHub = useCallback(async () => {
    if (oauthConnecting) return;
    setOauthConnecting(true);
    try {
      await oauthService.connect(OAUTH_PROVIDERS.GITHUB);
    } catch (error) {
      setOauthConnecting(false);
      notify.error({
        title: t`Could not connect GitHub`,
        message: errorMessage(error, t`GitHub authorization did not complete.`),
        forceToast: true,
      });
    }
  }, [oauthConnecting, t]);

  /**
   * The exact-folder adoption the Project "Link to cloud" button runs. Adopt in
   * place: the agent lives inside this repository, so a clone or a copy
   * somewhere else would publish a different tree than the one being edited.
   */
  const runSetup = useCallback(async () => {
    if (!project || !projectMount || setupBusy) return;
    setSetupBusy(true);
    try {
      const result = await launchWizard('git-context-folder', {
        title: t`Set up Git for deploying`,
        targetTypeId: project.typeId.toString(),
        payload: {
          projectId: project.id,
          scope: 'private',
          mode: 'adopt',
          path: projectMount,
          name: project.name,
        },
        prompt:
          `Set up Git in the exact project folder ${projectMount}. Initialize it there if needed, ` +
          'configure a GitHub origin, commit the entire repository, and push its branch. ' +
          'Do not clone or copy it elsewhere.',
      });
      if (result.status === 'error') {
        notify.error({ title: t`Could not set up Git`, message: result.errorStr ?? undefined, forceToast: true });
      } else if (result.status === 'done') {
        notify.success({ title: t`Git is set up` });
      }
    } catch (error) {
      notify.error({
        title: t`Could not set up Git`,
        message: errorMessage(error, t`Git setup failed.`),
        forceToast: true,
      });
    } finally {
      setSetupBusy(false);
      // One re-check, on an explicit completion — on every way out, including
      // cancellation, because the wizard may have got part of the way there.
      preflight.refetch();
    }
  }, [preflight, project, projectMount, setupBusy, t]);

  const labels: Record<DeployStepId, string> = {
    'cloud-login': t`Signed in to Flowpad cloud`,
    github: t`GitHub connected`,
    project: t`Project linked to cloud`,
    repo: t`Git repository ready`,
    pushed: t`Changes committed and pushed`,
  };

  const blocker = deployBlocker(states);

  const actionButton = (label: string, testId: string, busy: boolean, run: () => void): ReactNode => (
    <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={run} data-testid={testId}>
      {busy && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
      {label}
    </Button>
  );

  const actionFor = (id: DeployStepId): ReactNode | undefined => {
    switch (id) {
      case 'cloud-login':
        return actionButton(t`Sign in`, 'agent-deploy-action-cloud-login', loginBusy, () => void runLogin());
      case 'github':
        return actionButton(t`Connect`, 'agent-deploy-action-github', oauthConnecting, () => void connectGitHub());
      case 'project':
        // The whole Project remediation, reused rather than re-implemented. It
        // runs its own preflight and gate dialog, and renders its green "Linked
        // to cloud" chip once the project is linked — which is why it is mounted
        // only while this row is the blocker, so that chip never doubles up with
        // the row's own Done marker.
        return project ? <ProjectPublishButton project={project} /> : undefined;
      case 'repo':
        return actionButton(t`Set up`, 'agent-deploy-action-repo', setupBusy, () => void runSetup());
      case 'pushed':
        return actionButton(t`Push`, 'agent-deploy-action-pushed', pushBusy, () => void push());
      default:
        return undefined;
    }
  };

  const steps: Step<DeployStepId>[] = DEPLOY_STEP_IDS.map((id) => {
    const state = states[id];
    return {
      id,
      label: labels[id],
      status: STEP_STATUS[state],
      detail:
        state === 'done'
          ? t`Done`
          : state === 'blocked'
            ? (preflight.reason ?? t`Couldn't read this project's Git status.`)
            : undefined,
      // Only the blocker is actionable, and only when it is actually fixable
      // here: offering to push a repository that does not exist yet is a button
      // that cannot work, and neither remediation reattaches a detached HEAD.
      action: id === blocker && state === 'todo' ? actionFor(id) : undefined,
    };
  });

  // The hub has no local checkout and no local credentials, so every row here
  // would be unanswerable there.
  if (hubMode) return null;

  return (
    <div className="mb-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        <Trans>Before you can deploy</Trans>
      </p>
      <StepList steps={steps} testId="agent-deploy-checklist" testIdPrefix="agent-deploy" />
    </div>
  );
}
