import { Agent, Deployment, KIND_AGENT, QueryRequest } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { Badge } from '@src/components/ui/badge';
import { useProjectAgents } from '@src/hooks/use-project-agents';
import { useMemo } from 'react';
import type { AssetCounter, AssetCounterGroup } from './types';

/** An agent plus the placements that make it "running". */
export interface AgentRow {
  agent: Agent;
  deployments: Deployment[];
}

// Every agent on the machine: the Total counter IS this list, so the number and
// its table are one fact.
const ALL_AGENTS = new QueryRequest({ type: Agent.type, scope: [], name: 'assetCounters:agents' });
// `query`, never `match` — see AgentDeploymentsSection: a `match` key is dropped
// and the list silently becomes every deployment on the machine.
const AGENT_DEPLOYMENTS = new QueryRequest({
  type: Deployment.type,
  scope: [],
  query: { kind: KIND_AGENT },
  name: 'assetCounters:agentDeployments',
});

/** Deployments grouped by the agent they place (`Deployment.agentTypeId`). */
export function deploymentsByAgent(deployments: Deployment[]): Map<string, Deployment[]> {
  const byAgent = new Map<string, Deployment[]>();
  for (const deployment of deployments) {
    const agentKey = deployment.agentTypeId?.toString();
    if (!agentKey) continue;
    const list = byAgent.get(agentKey) ?? [];
    list.push(deployment);
    byAgent.set(agentKey, list);
  }
  return byAgent;
}

export function toAgentRows(agents: Agent[], byAgent: Map<string, Deployment[]>): AgentRow[] {
  return [...agents]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((agent) => ({ agent, deployments: byAgent.get(agent.typeId.toString()) ?? [] }));
}

/** Running = one of the project's agents that has a deployment. */
export function runningRows(projectRows: AgentRow[]): AgentRow[] {
  return projectRows.filter((row) => row.deployments.length > 0);
}

function useAgentCounters(): AssetCounter<AgentRow>[] {
  const { project } = useProject(null);
  // No limit to ask for: the hook returns every agent under the project's roots,
  // and it is the strip that slices for display.
  const { agents: projectAgents, isLoading: projectLoading } = useProjectAgents(project);
  const { data: allAgents = [], isLoading: allLoading } = useEntitiesQuery<Agent>(ALL_AGENTS);
  const { data: deployments = [], isLoading: deploymentsLoading } = useEntitiesQuery<Deployment>(AGENT_DEPLOYMENTS);

  // Separate memos: each watch pushes a fresh array, and a deployment change
  // must not re-sort every agent on the machine twice over.
  const byAgent = useMemo(() => deploymentsByAgent(deployments), [deployments]);
  const projectRows = useMemo(() => toAgentRows(projectAgents, byAgent), [projectAgents, byAgent]);
  const allRows = useMemo(() => toAgentRows(allAgents, byAgent), [allAgents, byAgent]);

  return useMemo(() => {
    const projectName = project?.name || <Trans>Project</Trans>;
    return [
      {
        key: 'running',
        label: <Trans>Running</Trans>,
        description: <Trans>Agents in {projectName} with a deployment</Trans>,
        items: runningRows(projectRows),
        isLoading: projectLoading || deploymentsLoading,
      },
      {
        key: 'project',
        label: projectName,
        description: <Trans>Every agent {projectName} can launch</Trans>,
        items: projectRows,
        isLoading: projectLoading,
      },
      {
        key: 'total',
        label: <Trans>Total</Trans>,
        description: <Trans>Every agent on this machine</Trans>,
        items: allRows,
        isLoading: allLoading,
      },
    ];
  }, [project?.name, projectRows, allRows, projectLoading, allLoading, deploymentsLoading]);
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

function DeploymentBadges({ deployments }: { deployments: Deployment[] }) {
  if (deployments.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {deployments.map((deployment) => {
        const paused = deployment.status.provider_state === 'paused';
        return (
          <Badge
            key={deployment.id}
            variant="outline"
            className={paused ? 'text-muted-foreground' : 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'}
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

export const agentCounterGroup: AssetCounterGroup<AgentRow> = {
  id: 'agents',
  type: Agent.type,
  useCounters: useAgentCounters,
  itemKey: (row) => row.agent.id,
  searchText: ({ agent, deployments }) =>
    [
      agent.displayName,
      agent.name,
      agent.description,
      agentSource(agent),
      ...deployments.map((d) => d.target.provider),
    ]
      .filter(Boolean)
      .join(' '),
  itemPointer: (row) => row.agent.dockPointer,
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
