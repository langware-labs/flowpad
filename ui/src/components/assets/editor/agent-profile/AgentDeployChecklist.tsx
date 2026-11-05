import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Project, TypeId, type Agent, type AgentVersionState } from '@sdk';
import { useProject } from '@sdk/react/hooks';

import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import { ProjectCloudLinkButton } from '@src/components/project-home/ProjectCloudLinkButton';
import { GitRequiredStrip } from '@src/components/git/GitRequiredStrip';
import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { errorMessage } from '@src/lib/error-message';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { notify } from '@src/notifications';
import type { Step, StepStatus } from '@src/hooks/use-step-flow';

import { AgentProjectPicker } from './AgentProjectPicker';
import { AgentPublishButton } from './AgentPublishButton';
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
 * one the button that fixes it: sign in to Flowpad cloud, give the agent a project,
 * then link that project to the cloud. A deploy publishes the agent into its
 * project's hub-hosted repository, so no git repository, remote, push or GitHub
 * connection is needed on this computer.
 *
 * The last row: whether the published version already has this computer's edits
 * (`agent.versionState().pending_changes`). It offers Publish when it doesn't and
 * never disables Deploy. In a git checkout it is a gate, and offers the commit
 * and push the deploy refuses to go without.
 *
 * Re-checks are EVENT-driven: the version is re-read when the agent changes and
 * after a publish. No interval, no polling.
 */
export function AgentDeployChecklist({ agent, onReadinessChange }: AgentDeployChecklistProps) {
  const { t } = useLingui();
  const hubMode = isHubOnly();

  const cloudAuthed = useCloudAuthed();
  // The agent's OWN project: the one open on the page may have nothing to do with it.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const projectId = movedTo ?? agent.project_id ?? null;
  const projectTypeId = useMemo(() => (projectId ? new TypeId(Project.type, projectId) : null), [projectId]);
  const { project, isLoading: projectLoading } = useProject(projectTypeId, { enabled: !!projectId });
  const requireCloudLogin = useCloudLoginGate();

  const [loginBusy, setLoginBusy] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  // What the commit would take, shown before it does: `null` until asked.
  const [commitFiles, setCommitFiles] = useState<string[] | null>(null);
  const [version, setVersion] = useState<AgentVersionState | null>(null);

  // No project, or one that no longer loads, is an answer: only a load under way is "still checking".
  const projectPublished = !projectId ? false : project ? project.remote === true : projectLoading ? null : false;

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

  const ready = deployReadyState(states, version?.git_native === true);
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

  /** What the deploy refuses to go without, in a click: every change in the checkout, committed and pushed. */
  const runCommit = useCallback(async () => {
    if (gitBusy || !version) return;
    setGitBusy(true);
    try {
      const git = await project?.getGitWorkdir();
      const pushed = await git?.push();
      // With no remote of its own the commit is the whole job: the hub repo is the checkout's remote.
      if (!pushed?.ok && !(pushed?.committed && !version.has_remote)) {
        notify.error({
          title: t`Could not commit and push`,
          message: pushed?.message ?? t`This project has no folder on this computer.`,
          forceToast: true,
        });
      }
    } catch (e) {
      notify.error({
        title: t`Could not commit and push`,
        message: errorMessage(e, t`It failed.`),
        forceToast: true,
      });
    } finally {
      setGitBusy(false);
      setCommitFiles(null);
      await loadVersion();
    }
  }, [gitBusy, version, project, loadVersion, t]);

  /** The files a commit would take, for the person to read first. Nothing to commit: just push. */
  const reviewCommit = useCallback(async () => {
    if ((version?.uncommitted ?? 0) === 0) return runCommit();
    setGitBusy(true);
    try {
      const git = await project?.getGitWorkdir();
      setCommitFiles(((await git?.getStatus())?.files ?? []).map((file) => file.path));
    } catch (e) {
      notify.error({ title: t`Could not list the changes`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setGitBusy(false);
    }
  }, [version, project, runCommit, t]);

  const pending = version?.pending_changes ?? 0;

  const labels: Record<DeployStepId, string> = {
    'cloud-login': t`Signed in to Flowpad cloud`,
    project: projectId ? t`Project linked to cloud` : t`Agent is in a project`,
    version: version?.git_native ? t`Project committed and pushed` : t`Published version up to date`,
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
        if (!projectId) return <AgentProjectPicker agent={agent} onMoved={setMovedTo} />;
        return project ? <ProjectCloudLinkButton project={project} /> : undefined;
      case 'version':
        // A git checkout is fixed in git, not by a Publish button.
        if (version?.git_native) {
          const label =
            (version.uncommitted ?? 0) === 0 ? t`Push` : version.has_remote ? t`Commit and push` : t`Commit`;
          if (commitFiles) return undefined; // the review below carries its own buttons
          return actionButton(label, 'agent-deploy-action-commit', gitBusy, () => void reviewCommit());
        }
        // Publishes, then re-reads the version.
        return (
          <AgentPublishButton
            agent={agent}
            onPublished={loadVersion}
            className="h-6 px-2 text-xs"
            testId="agent-deploy-action-version"
          />
        );
      default:
        return undefined;
    }
  };

  const detailFor = (id: DeployStepId, state: DeployStepState): string | undefined => {
    if (id === 'project' && state === 'todo' && !projectId) {
      return t`This agent is in no project, so the cloud has nowhere to put it — choose one`;
    }
    if (id === 'project' && state === 'todo' && !project) return t`Its project could not be loaded`;
    if (id === 'version' && state === 'todo' && version?.git_native) {
      const uncommitted = version.uncommitted ?? 0;
      const unpushed = version.unpushed ?? 0;
      if (uncommitted > 0) {
        const then = version.has_remote ? t`commit and push, then deploy` : t`commit, then deploy`;
        return uncommitted === 1
          ? t`1 change not committed — ${then}`
          : t`${uncommitted} changes not committed — ${then}`;
      }
      return unpushed === 1
        ? t`1 commit not pushed — push, then deploy`
        : t`${unpushed} commits not pushed — push, then deploy`;
    }
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
      {commitFiles && (
        <div className="mt-2 rounded-md border p-2" data-testid="agent-deploy-commit-review">
          <p className="mb-1 text-xs text-muted-foreground">
            <Trans>Everything below goes into the commit, not only the agent:</Trans>
          </p>
          <ul className="mb-2 max-h-32 overflow-y-auto font-mono text-xs">
            {commitFiles.map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              disabled={gitBusy}
              onClick={() => setCommitFiles(null)}
              data-testid="agent-deploy-commit-cancel"
            >
              <Trans>Cancel</Trans>
            </Button>
            {actionButton(
              version?.has_remote ? t`Commit and push` : t`Commit`,
              'agent-deploy-commit-confirm',
              gitBusy,
              () => void runCommit(),
            )}
          </div>
        </div>
      )}
      {version && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="agent-deploy-uploads">
          {version.git_native ? (
            <Trans>
              A deploy uploads this project's commits to Flowpad cloud — the whole repository, not only the agent.
            </Trans>
          ) : (
            <Trans>A deploy uploads only this agent's folder to Flowpad cloud.</Trans>
          )}
        </p>
      )}
      {/* No git yet: neither its own checkout nor Flowpad git (the hub repo a linked project gets). */}
      {project && version?.git_native === false && !projectPublished && (
        <GitRequiredStrip project={project} className="mt-2" />
      )}
    </div>
  );
}
