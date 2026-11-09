import { Agent, ComputeNode, Deployment, Issue, QueryRequest, type InboundNumber } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { Badge } from '@src/components/ui/badge';
import { useProjectAgents } from '@src/hooks/use-project-agents';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { type MouseEvent, type ReactNode, useMemo } from 'react';
import { useAgentChannels } from '@src/components/agent-resources/AgentWebhooksSection';
import { needsGitConnection } from '@src/components/assets/editor/git-connection';
import { type DrillIn, useDrillIn, useHomeItems } from '@src/components/items/drill-in';
import { cn } from '@src/lib/utils';
import { crossCounters, useScopes } from './axes';
import { isLiveDeployment, isRunning, runPauseStatuses } from './placement';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import type { ItemCardValue } from '@src/components/items/ItemCard';
import { agentState } from '@src/components/items/item-state';
import { roleOf, WITH_PERMISSIONS } from '@src/components/items/role';
import type { AssetCounter, AssetCounterGroup } from './types';

/** An agent plus the placements that make it "running". */
export interface AgentRow {
  agent: Agent;
  deployments: Deployment[];
}

// Every agent on the machine: the Total counter IS this list, so the number and
// its table are one fact.
/** Every agent the caller can reach, with their role on each — one request for hub and desk. */
export const ALL_AGENTS = new QueryRequest({
  type: Agent.type,
  scope: [],
  query: WITH_PERMISSIONS,
  name: 'assetCounters:agents',
});
// Every deployment; `deploymentsByAgent` keys them by main agent, `deploymentsByProject` by the project placed.
// One request for every counter group, so they share one watch.
export const ALL_DEPLOYMENTS = new QueryRequest({
  type: Deployment.type,
  scope: [],
  query: null,
  name: 'assetCounters:deployments',
});

/** The same deployments with the caller's role on each — only the Deployments tab shows it. */
export const DEPLOYMENTS_WITH_ROLES = new QueryRequest({
  type: Deployment.type,
  scope: [],
  query: WITH_PERMISSIONS,
  name: 'assetCounters:deploymentsWithRoles',
});

/** Deployments grouped by the project they place, keyed by project id (`Deployment.projectTypeId`). */
export function deploymentsByProject(deployments: Deployment[]): Map<string, Deployment[]> {
  const byProject = new Map<string, Deployment[]>();
  for (const deployment of deployments) {
    const key = deployment.projectTypeId?.id;
    if (!key) continue;
    const list = byProject.get(key) ?? [];
    list.push(deployment);
    byProject.set(key, list);
  }
  return byProject;
}

/** Deployments grouped by their main agent (`Deployment.mainAgentTypeId`). */
export function deploymentsByAgent(deployments: Deployment[]): Map<string, Deployment[]> {
  const byAgent = new Map<string, Deployment[]>();
  for (const deployment of deployments) {
    const agentKey = deployment.mainAgentTypeId?.toString();
    if (!agentKey) continue;
    const list = byAgent.get(agentKey) ?? [];
    list.push(deployment);
    byAgent.set(agentKey, list);
  }
  return byAgent;
}

/** The user's agent, not one Flowpad ships: the Flowpad Assistant's agents are
 *  indexed with `scope === 'system'` (their `system` flag reads false, so it
 *  can't tell them apart). */
export function isUserAgent(agent: Agent): boolean {
  return (agent as { scope?: string | null }).scope !== 'system';
}

/** The user's agents as rows — Flowpad's own agents are neither counted nor listed. */
export function toAgentRows(agents: Agent[], byAgent: Map<string, Deployment[]>): AgentRow[] {
  return agents
    .filter(isUserAgent)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((agent) => ({ agent, deployments: byAgent.get(agent.typeId.toString()) ?? [] }));
}

const agentCreator = (row: AgentRow) => row.agent.created_by;

function useAgentCounters(): AssetCounter<AgentRow>[] {
  const { project } = useProject(null);
  // No limit to ask for: the hook returns every agent under the project's roots,
  // and it is the strip that slices for display.
  const { agents: projectAgents, isLoading: projectLoading } = useProjectAgents(project);
  const { data: allAgents = [], isLoading: allLoading } = useEntitiesQuery<Agent>(ALL_AGENTS);
  const { data: deployments = [], isLoading: deploymentsLoading } = useEntitiesQuery<Deployment>(ALL_DEPLOYMENTS);

  // Separate memos: each watch pushes a fresh array, and a deployment change
  // must not re-sort every agent on the machine twice over.
  const byAgent = useMemo(() => deploymentsByAgent(deployments), [deployments]);
  const projectRows = useMemo(() => toAgentRows(projectAgents, byAgent), [projectAgents, byAgent]);
  const allRows = useMemo(() => toAgentRows(allAgents, byAgent), [allAgents, byAgent]);

  const scopes = useScopes(
    { items: allRows, isLoading: allLoading },
    { items: projectRows, isLoading: projectLoading },
    agentCreator,
  );
  return useMemo(
    () =>
      crossCounters({
        label: <Trans>Agents</Trans>,
        scopes,
        // Agents are placed or not; a paused agent is not a status of its own.
        statuses: runPauseStatuses<AgentRow>(isRunning, null, deploymentsLoading),
      }),
    [scopes, deploymentsLoading],
  );
}

/** The project folder an agent comes from: the directory above `agentic-assets/`. */
export function agentSource(agent: Agent): string {
  const dir = agent.bundleDirectory;
  if (!dir) return '';
  const parts = dir.split('/').filter(Boolean);
  const assets = parts.lastIndexOf('agentic-assets');
  if (assets > 0) return parts[assets - 1];
  return parts.at(-2) ?? '';
}

export function DeploymentBadges({ deployments }: { deployments: Deployment[] }) {
  if (deployments.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {deployments.map((deployment) => {
        const paused = !isLiveDeployment(deployment);
        return (
          <Badge
            key={deployment.id}
            variant="outline"
            className={
              paused ? 'text-muted-foreground' : 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
            }
            title={deployment.status.provider_state ?? undefined}
          >
            {deployment.target.provider || deployment.name}
            {paused && <Trans> · paused</Trans>}
          </Badge>
        );
      })}
    </div>
  );
}

function SummaryRow({
  label,
  count,
  live,
  onOpen,
  testId,
}: {
  label: ReactNode;
  count: number;
  live?: boolean;
  onOpen: (() => void) | null;
  testId: string;
}) {
  const click = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen?.();
  };
  return (
    <button
      type="button"
      onClick={click}
      disabled={!onOpen}
      className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      data-testid={testId}
    >
      <span className="text-muted-foreground">{label}</span>
      {live && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />}
      <span className={cn('ml-auto tabular-nums', count > 0 ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {count}
      </span>
    </button>
  );
}

/** The Channels row: the agent's links, read from the hub (`agent.channels()`), shown once they arrive. */
function ChannelsRow({ agent, open }: { agent: Agent; open: ((d: Omit<DrillIn, 'label'>) => void) | null }) {
  const channels = useAgentChannels(agent);
  const ids = useMemo(() => new Set(channels?.webhooks.map((w) => w.id) ?? []), [channels]);
  if (!channels) return null;
  return (
    <SummaryRow
      label={<Trans>Channels</Trans>}
      count={channels.webhooks.length}
      onOpen={open && (() => open({ type: 'webhook', test: (n: InboundNumber) => ids.has(n.claim.id) }))}
      testId="agent-summary-channels"
    />
  );
}

/** An agent card's footer: what it runs as, on, through and what is wrong — each row opens that list for the agent. */
export function AgentSummaryTable({ row }: { row: AgentRow }) {
  const drillIn = useDrillIn();
  const issues = useHomeItems<Issue>(Issue.type);
  const machines = useHomeItems<{ node: ComputeNode }>(ComputeNode.type);
  const { agent, deployments } = row;
  const typeid = agent.typeId.toString();
  const nodeIds = useMemo(
    () => new Set(deployments.map((d) => d.computeNodeId).filter((id): id is string => !!id)),
    [deployments],
  );
  const concerns = (i: Issue) => i.subject_typeid === typeid || i.affected.includes(typeid);
  const issueCount = issues?.filter(concerns).length ?? 0;
  const open = drillIn && ((d: Omit<DrillIn, 'label'>) => drillIn({ ...d, label: agent.displayName }));
  return (
    <div className="grid w-full grid-cols-2 gap-x-3 gap-y-0.5 text-xs" data-testid="agent-summary">
      <SummaryRow
        label={<Trans>Deployments</Trans>}
        count={deployments.length}
        live={deployments.some(isLiveDeployment)}
        onOpen={
          open &&
          (() => open({ type: Deployment.type, test: (d: Deployment) => d.mainAgentTypeId?.toString() === typeid }))
        }
        testId="agent-summary-deployments"
      />
      <SummaryRow
        label={<Trans>Machines</Trans>}
        // Machines that exist: a deployment row can still name a machine that is gone.
        count={machines ? machines.filter((m) => nodeIds.has(m.node.id)).length : nodeIds.size}
        onOpen={
          open && (() => open({ type: ComputeNode.type, test: (m: { node: ComputeNode }) => nodeIds.has(m.node.id) }))
        }
        testId="agent-summary-machines"
      />
      {isHubOnly() && <ChannelsRow agent={agent} open={open} />}
      {issues && (
        <SummaryRow
          label={<Trans>Issues</Trans>}
          count={issueCount}
          onOpen={open && (() => open({ type: Issue.type, test: concerns }))}
          testId="agent-summary-issues"
        />
      )}
    </div>
  );
}

/** On the hub, an agent with no git link cannot be opened there: it has to be published from the desktop first. */
const agentNeedsGit = (agent: Agent) => isHubOnly() && needsGitConnection(true, 'git', agent);

/** An agent as an item card — the same on hub and desktop. */
export const agentCard = (row: AgentRow): ItemCardValue => ({
  title: row.agent.displayName,
  icon: iconForType(Agent.type),
  state: agentState(row.deployments.length > 0, isRunning(row)),
  role: roleOf(row.agent),
  warning: agentNeedsGit(row.agent) ? (
    <>
      <Trans>Needs git</Trans>
      <span className="block text-muted-foreground" data-testid="agent-needs-git">
        <Trans>Publish it from the desktop app</Trans>
      </span>
    </>
  ) : undefined,
  description: row.agent.description || undefined,
  at: { date: row.agent.updated_date },
  footer: <AgentSummaryTable row={row} />,
});

export const agentCounterGroup: AssetCounterGroup<AgentRow> = {
  id: 'agents',
  type: Agent.type,
  useCounters: useAgentCounters,
  itemKey: (row) => row.agent.id,
  searchText: ({ agent, deployments }) =>
    [agent.displayName, agent.name, agent.description, agentSource(agent), ...deployments.map((d) => d.target.provider)]
      .filter(Boolean)
      .join(' '),
  itemPointer: (row) => row.agent.dockPointer,
  card: agentCard,
  role: (row) => roleOf(row.agent),
  columns: [
    {
      key: 'agent',
      header: <Trans>Agent</Trans>,
      cell: ({ agent }) => (
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar agent={agent} className="h-8 w-8 shrink-0 text-sm" glyphClassName="h-4 w-4 text-lg" />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{agent.displayName}</div>
            {agent.description && <div className="truncate text-xs text-muted-foreground">{agent.description}</div>}
          </div>
        </div>
      ),
      className: 'w-[45%] max-w-0',
    },
    {
      key: 'status',
      header: <Trans>Status</Trans>,
      cell: ({ agent }) =>
        agent.enabled ? (
          <Badge variant="secondary">
            <Trans>Enabled</Trans>
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            <Trans>Disabled</Trans>
          </Badge>
        ),
    },
    {
      key: 'deployments',
      header: <Trans>Deployments</Trans>,
      cell: ({ deployments }) => <DeploymentBadges deployments={deployments} />,
    },
    {
      key: 'source',
      header: <Trans>Source</Trans>,
      cell: ({ agent }) => (
        <span className="text-muted-foreground" title={agent.bundleDirectory ?? undefined}>
          {agentSource(agent)}
        </span>
      ),
    },
  ],
};
