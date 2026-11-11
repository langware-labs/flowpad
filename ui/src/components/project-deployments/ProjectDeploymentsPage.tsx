import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronLeft, Laptop, Plus } from 'lucide-react';
import { Agent, Deployment, QueryRequest, type Project } from '@sdk';
import { isTerminal } from '@sdk/activity';
import { useWatch } from '@sdk/react/hooks';
import { isHubOnly } from '@sdk/utils/hub-runtime';

import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { StatePill } from '@src/components/items/ItemCard';
import { deploymentRowState } from '@src/components/items/item-state';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { NewDeploymentDialog } from '@src/components/assets/editor/agent-profile/NewDeploymentDialog';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { useActivitySpec } from '@src/store/activity-store';

import { useSourceLabel } from './DeploymentContext';
import { ProjectDeploymentPage } from './ProjectDeploymentPage';
import { PROJECT_DEPLOY_MAIN_AGENT_OPTION, PROJECT_DEPLOYMENT_OPTION } from './project-deployments-url';
import { useCameFromAgent } from './use-came-from-agent';

/**
 * The project's deployments (`/dock/project/<id>/project-deployments`): every placement of the project — this
 * computer's one switch, then each cloud machine with its main agent, source and apps — and New deployment.
 * `?deployment=<id>` opens one deployment's page; `?deploy_main_agent=<agentId>` opens New deployment with that
 * agent preset as main (an agent page's "Deploy"). Both are the URL's: a click only navigates.
 */
export function ProjectDeploymentsPage({ project }: { project: Project }) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const hub = isHubOnly();
  const options = currentDock?.options ?? {};
  const selectedId = options[PROJECT_DEPLOYMENT_OPTION] ?? null;
  const presetMainAgent = options[PROJECT_DEPLOY_MAIN_AGENT_OPTION] ?? null;
  // The agent the page came from outlives the dialog: this computer's switch places it too.
  const cameFromAgent = useCameFromAgent(presetMainAgent);
  const [newOpen, setNewOpen] = useState(false);
  const dialogOpen = newOpen || !!presetMainAgent;

  const deploymentsRequest = useMemo(
    () => new QueryRequest({ type: Deployment.type, scope: [project.typeId], name: 'ProjectDeploymentsPage' }),
    [project.typeId],
  );
  const { data: rows = [], isLoading, refetch } = useEntitiesQuery<Deployment>(deploymentsRequest);
  // A project's placements only — this computer's own row and a hub micro app are someone else's.
  const deployments = useMemo(() => rows.filter((d) => d.projectTypeId?.id === project.id), [rows, project.id]);
  const local = deployments.find((d) => d.isLocal) ?? null;
  const cloud = deployments.filter((d) => !d.isLocal);

  const agentsRequest = useMemo(
    () => new QueryRequest({ type: Agent.type, scope: [project.typeId], name: 'ProjectDeploymentsPage.agents' }),
    [project.typeId],
  );
  const { data: agents = [] } = useEntitiesQuery<Agent>(agentsRequest);
  const agentName = (d: Deployment) => agents.find((a) => a.id === d.mainAgentId)?.name ?? null;
  const sourceLabel = useSourceLabel();

  useDeployProgress(project, refetch);

  const go = (opts: { deploymentId?: string | null; mainAgentId?: string | null } = {}) =>
    navigation.openDock(DockPointer.forProjectDeployments(String(project.id), opts));

  const closeDialog = (open: boolean) => {
    if (open) return;
    setNewOpen(false);
    if (presetMainAgent && currentDock) navigation.openDock(currentDock.withOption(PROJECT_DEPLOY_MAIN_AGENT_OPTION, null));
  };

  if (selectedId) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="project-deployments-selected">
        <Button variant="ghost" size="sm" className="mb-2 self-start" onClick={() => go()} data-testid="project-deployments-back">
          <ChevronLeft className="me-1 h-4 w-4" />
          <Trans>Deployments</Trans>
        </Button>
        <ProjectDeploymentPage project={project} deploymentId={selectedId} />
      </div>
    );
  }

  const Icon = iconForType(Deployment.type);
  return (
    <section className="flex flex-col gap-4" data-testid="project-deployments">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">
          <Trans>Deployments</Trans>
        </h1>
        <Button size="sm" variant="outline" onClick={() => setNewOpen(true)} data-testid="project-new-deployment">
          <Plus className="me-1.5 h-3.5 w-3.5" />
          <Trans>New deployment</Trans>
        </Button>
      </div>

      {!hub && <LocalSwitch project={project} local={local} mainAgent={cameFromAgent} />}

      {isLoading ? null : deployments.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="project-deployments-empty">
          <Trans>Not deployed yet — launch one to give this project a machine of its own.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="project-deployments-list">
          {[...(local ? [local] : []), ...cloud].map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-start hover:bg-muted/60"
                onClick={() => go({ deploymentId: d.id })}
                data-testid={`project-deployment-row-${d.id}`}
              >
                {d.isLocal ? (
                  <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{d.isLocal ? t`This computer` : d.name}</span>
                  <span className="block truncate text-xs text-muted-foreground" data-testid={`project-deployment-context-${d.id}`}>
                    {[
                      agentName(d) ?? t`No agent`,
                      sourceLabel(d),
                      d.isLocal ? null : `${d.target.provider} · ${d.environment}`,
                      d.exposes.length ? d.exposes.map((e) => e.name).join(', ') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <StatePill state={deploymentRowState(d)} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialogOpen && (
        <NewDeploymentDialog
          project={project}
          presetMainAgentId={presetMainAgent}
          open
          onOpenChange={closeDialog}
          onLaunched={(id) => (id ? go({ deploymentId: id }) : undefined)}
        />
      )}
    </section>
  );
}

/** "Run on this computer": the project's one local deployment as a switch. On deploys it here; off deletes it. */
function LocalSwitch({
  project,
  local,
  mainAgent,
}: {
  project: Project;
  local: Deployment | null;
  /** The agent the page came from: the local deployment's main agent. */
  mainAgent: string | null;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next)
        await project.deploy({
          provider: 'local',
          ...(mainAgent ? { mainAgentId: `${Agent.type}-${mainAgent}` } : {}),
        });
      else await local?.delete();
    } catch (e) {
      const failure = t`Could not change where the project runs`;
      notify.error({ title: failure, message: errorMessage(e, failure), forceToast: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2.5" data-testid="project-local-toggle">
      <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <Trans>Run on this computer</Trans>
        </div>
        <div className="text-xs text-muted-foreground">
          {local ? (
            <Trans>Running here · free while this computer is awake</Trans>
          ) : (
            <Trans>Off · turn on to run it here, free, while this computer is awake</Trans>
          )}
        </div>
      </div>
      <Switch
        checked={!!local}
        disabled={busy}
        onCheckedChange={(next) => void toggle(next)}
        aria-label={t`Run on this computer`}
        data-testid="project-local-toggle-switch"
      />
    </div>
  );
}

/** The deploys seen running whose end is not told yet: one that ends failed is told once. Kept across mounts. */
const runningDeploys = new Set<string>();

/**
 * A cloud deploy runs on after its dialog closed, reporting on the project's `deploy` activity: re-read the list
 * as it moves, and say so when it fails — nothing else on screen would.
 */
function useDeployProgress(project: Project, reload: () => Promise<void>) {
  const { t } = useLingui();
  useWatch(project.typeId, true);
  const deploy = useActivitySpec('deploy', project.typeId.toString());
  const moved = deploy ? `${deploy.state}:${deploy.children.map((step) => step.state).join()}` : null;
  useEffect(() => {
    if (moved) void reload();
  }, [moved, reload]);
  useEffect(() => {
    if (!deploy) return;
    if (!isTerminal(deploy)) {
      runningDeploys.add(deploy.activity_id);
      return;
    }
    if (!runningDeploys.delete(deploy.activity_id) || deploy.state === 'completed') return;
    notify.error({ title: t`Could not deploy`, message: deploy.message ?? t`Deploy failed.`, forceToast: true });
  }, [deploy, t]);
}
