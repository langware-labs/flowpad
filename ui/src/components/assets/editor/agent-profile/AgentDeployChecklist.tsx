import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Agent, AgentVersionState } from '@sdk';
import { useProject } from '@sdk/react/hooks';

import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import { ProjectCloudLinkButton } from '@src/components/project-home/ProjectCloudLinkButton';
import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { errorMessage } from '@src/lib/error-message';
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
 * Asks the backend's deploy gates BEFORE the click, and gives the first unmet
 * one the button that fixes it: sign in to Flowpad cloud, then link the project
 * to the cloud. A deploy publishes the agent into its project's hub-hosted
 * repository, so no git repository, remote, push or GitHub connection is
 * needed on this computer.
 *
 * The last row is advice, not a gate: whether the published version already
 * has this computer's edits (`agent.versionState().pending_changes`). It offers
 * Publish when it doesn't, and never disables Deploy.
 *
 * Re-checks are EVENT-driven: the version is re-read when the agent changes and
 * after a publish. No interval, no polling.
 */
export function AgentDeployChecklist({ agent, onReadinessChange }: AgentDeployChecklistProps) {
  const { t } = useLingui();
  const hubMode = isHubOnly();

  const cloudAuthed = useCloudAuthed();
  const { project } = useProject();
  const requireCloudLogin = useCloudLoginGate();

  const [loginBusy, setLoginBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [version, setVersion] = useState<AgentVersionState | null>(null);

  const projectPublished = project ? project.remote === true : null;

  const loadVersion = useCallback(async () => {
    if (hubMode) return;
    try {
      setVersion(await agent.versionState());
    } catch {
      // Unreadable is "unknown", never "stale": the row stays checking and
      // Deploy stays enabled (the version row is advice either way).
      setVersion(null);
    }
  }, [agent, hubMode]);

  useEffect(() => {
    void loadVersion();
  }, [loadVersion, agent.updated_date]);

  const states = useMemo(
    () => deployReadiness({ cloudAuthed, projectPublished, version }),
    [cloudAuthed, projectPublished, version],
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
      }
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy, requireCloudLogin, t]);

  /** Publish this computer's edits into the project's hub repo, then re-read the version. */
  const runPublish = useCallback(async () => {
    if (publishBusy) return;
    setPublishBusy(true);
    try {
      await agent.publish({ force: true });
      notify.success({ title: t`Published` });
    } catch (error) {
      notify.error({
        title: t`Could not publish`,
        message: errorMessage(error, t`Publish failed.`),
        forceToast: true,
      });
    } finally {
      setPublishBusy(false);
      await loadVersion();
    }
  }, [agent, loadVersion, publishBusy, t]);

  const pending = version?.pending_changes ?? 0;

  const labels: Record<DeployStepId, string> = {
    'cloud-login': t`Signed in to Flowpad cloud`,
    project: t`Project linked to cloud`,
    version: t`Published version up to date`,
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
      case 'project':
        // The whole Project remediation, reused rather than re-implemented. It
        // renders its own green "Linked to cloud" chip once the project is
        // linked — which is why it is mounted only while this row is the
        // blocker, so that chip never doubles up with the row's Done marker.
        return project ? <ProjectCloudLinkButton project={project} /> : undefined;
      case 'version':
        return actionButton(t`Publish`, 'agent-deploy-action-version', publishBusy, () => void runPublish());
      default:
        return undefined;
    }
  };

  const detailFor = (id: DeployStepId, state: DeployStepState): string | undefined => {
    if (id === 'version' && state === 'todo') {
      return pending === 1 ? t`1 change not published` : t`${pending} changes not published`;
    }
    if (id === 'version' && state === 'done' && version && !version.published) return t`Published when you deploy`;
    return state === 'done' ? t`Done` : undefined;
  };

  const steps: Step<DeployStepId>[] = DEPLOY_STEP_IDS.map((id) => {
    const state = states[id];
    return {
      id,
      label: labels[id],
      status: STEP_STATUS[state],
      detail: detailFor(id, state),
      // Only the blocker is actionable: linking a project before signing in to
      // the cloud is a button that cannot work.
      action: id === blocker && state === 'todo' ? actionFor(id) : undefined,
    };
  });

  // The hub has no local project and no local credentials, so every row here
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
