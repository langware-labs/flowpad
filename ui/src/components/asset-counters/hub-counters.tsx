import { Agent, ComputeNode, Deployment, ExecutionEnvironmentStatus, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { isLaunched, useSandboxes } from '@src/hooks/use-sandboxes';
import { ALL_DEPLOYMENTS, DeploymentBadges, deploymentsByAgent, toAgentRows, type AgentRow } from './agent-counters';
import { StatusDot } from './AssetItems';
import type { AssetCounterGroup } from './types';
import { FundedBy } from '@src/components/assets/editor/agent-profile/deployment/DeploymentFunding';

/**
 * The hub home's counters. Org-wide graph queries with no project scope: the
 * hub has no "current project" to count within, only what the caller can reach.
 */

const HUB_AGENTS = new QueryRequest({ type: Agent.type, scope: [], query: null, name: 'hubCounters:agents' });

/** A deployment is live unless its provider paused it — the rule `DeploymentBadges` paints. */
export function isLiveDeployment(deployment: Deployment): boolean {
  return deployment.status.provider_state !== 'paused';
}

/** An active agent has at least one live deployment. */
export function isActiveAgent(row: AgentRow): boolean {
  return row.deployments.some(isLiveDeployment);
}

/** A machine plus its probed status (absent until probed, or never launched). */
export interface MachineRow {
  node: ComputeNode;
  status: ExecutionEnvironmentStatus | null;
}

export function isActiveMachine(row: MachineRow): boolean {
  return row.status === ExecutionEnvironmentStatus.READY;
}

const MACHINE_STATUS_LABEL: Record<ExecutionEnvironmentStatus, ReactNode> = {
  [ExecutionEnvironmentStatus.READY]: <Trans>Running</Trans>,
  [ExecutionEnvironmentStatus.PAUSED]: <Trans>Paused</Trans>,
  [ExecutionEnvironmentStatus.NOT_FOUND]: <Trans>Not found</Trans>,
  [ExecutionEnvironmentStatus.ERROR]: <Trans>Unreachable</Trans>,
  [ExecutionEnvironmentStatus.NEW]: <Trans>New</Trans>,
  [ExecutionEnvironmentStatus.DISCONNECTED]: <Trans>Disconnected</Trans>,
};

function machineStatusLabel(row: MachineRow): ReactNode {
  if (row.status) return MACHINE_STATUS_LABEL[row.status];
  return isLaunched(row.node) ? <Trans>Checking…</Trans> : <Trans>Not started</Trans>;
}

export const hubAgentCounterGroup: AssetCounterGroup<AgentRow> = {
  id: 'hub-agents',
  type: Agent.type,
  useCounters: () => {
    const { data: agents = [], isLoading } = useEntitiesQuery<Agent>(HUB_AGENTS);
    const { data: deployments = [], isLoading: deploymentsLoading } = useEntitiesQuery<Deployment>(ALL_DEPLOYMENTS);
    const rows = useMemo(() => toAgentRows(agents, deploymentsByAgent(deployments)), [agents, deployments]);
    return useMemo(
      () => [
        {
          key: 'all',
          label: <Trans>Agents</Trans>,
          description: <Trans>Every agent you can reach</Trans>,
          items: rows,
          isLoading,
        },
        {
          key: 'active',
          label: <Trans>Active</Trans>,
          description: <Trans>Agents with a live deployment</Trans>,
          items: rows.filter(isActiveAgent),
          isLoading: isLoading || deploymentsLoading,
        },
      ],
      [rows, isLoading, deploymentsLoading],
    );
  },
  itemKey: (row) => row.agent.id,
  searchText: ({ agent }) => [agent.displayName, agent.description].filter(Boolean).join(' '),
  itemPointer: (row) => row.agent.dockPointer,
  card: (row) => {
    const active = isActiveAgent(row);
    return {
      title: row.agent.displayName,
      description: row.agent.description,
      status: { label: active ? <Trans>Active</Trans> : <Trans>Idle</Trans>, active },
      // No deployment yet: the Idle badge already says so, a bare dash adds nothing.
      footer: row.deployments.length > 0 ? <DeploymentBadges deployments={row.deployments} /> : undefined,
    };
  },
  columns: [
    {
      key: 'agent',
      header: <Trans>Agent</Trans>,
      cell: ({ agent }) => <span className="truncate font-medium text-foreground">{agent.displayName}</span>,
      className: 'w-[45%] max-w-0',
    },
    {
      key: 'status',
      header: <Trans>Status</Trans>,
      cell: (row) => (
        <StatusDot active={isActiveAgent(row)}>
          {isActiveAgent(row) ? <Trans>Active</Trans> : <Trans>Idle</Trans>}
        </StatusDot>
      ),
    },
    {
      key: 'deployments',
      header: <Trans>Deployments</Trans>,
      cell: ({ deployments }) => <DeploymentBadges deployments={deployments} />,
    },
  ],
};

export const hubMachineCounterGroup: AssetCounterGroup<MachineRow> = {
  id: 'hub-machines',
  type: ComputeNode.type,
  useCounters: () => {
    const { sandboxes, details, isLoading } = useSandboxes();
    const rows = useMemo(
      () => sandboxes.map((node) => ({ node, status: details[node.id]?.status ?? null })),
      [sandboxes, details],
    );
    return useMemo(
      () => [
        {
          key: 'all',
          label: <Trans>Machines</Trans>,
          description: <Trans>Every machine you can reach</Trans>,
          items: rows,
          isLoading,
        },
        {
          key: 'active',
          label: <Trans>Active</Trans>,
          description: <Trans>Machines that are running</Trans>,
          items: rows.filter(isActiveMachine),
          isLoading,
        },
      ],
      [rows, isLoading],
    );
  },
  itemKey: (row) => row.node.id,
  searchText: ({ node }) => node.name ?? '',
  itemPointer: (row) => row.node.dockPointer,
  card: (row) => ({
    title: row.node.name,
    status: { label: machineStatusLabel(row), active: isActiveMachine(row) },
  }),
  columns: [
    {
      key: 'machine',
      header: <Trans>Machine</Trans>,
      cell: ({ node }) => <span className="truncate font-medium text-foreground">{node.name}</span>,
      className: 'w-[60%] max-w-0',
    },
    {
      key: 'status',
      header: <Trans>Status</Trans>,
      cell: (row) => <StatusDot active={isActiveMachine(row)}>{machineStatusLabel(row)}</StatusDot>,
    },
  ],
};

export const hubDeploymentCounterGroup: AssetCounterGroup<Deployment> = {
  id: 'hub-deployments',
  type: Deployment.type,
  useCounters: () => {
    const { data: deployments = [], isLoading } = useEntitiesQuery<Deployment>(ALL_DEPLOYMENTS);
    return useMemo(
      () => [
        {
          key: 'all',
          label: <Trans>Deployments</Trans>,
          description: <Trans>Every deployment you can reach</Trans>,
          items: deployments,
          isLoading,
        },
      ],
      [deployments, isLoading],
    );
  },
  itemKey: (d) => d.id,
  searchText: (d) => [d.name, d.target.provider].filter(Boolean).join(' '),
  // Its own page (funding, threads, health) when it places an agent; else where it sits in the world view.
  itemPointer: (d) => d.agentPagePointer ?? d.dockPointer,
  card: (d) => {
    const live = isLiveDeployment(d);
    return {
      title: d.name,
      status: { label: live ? <Trans>Live</Trans> : <Trans>Paused</Trans>, active: live },
      description: <FundedBy deployment={d} />,
      footer: d.target.provider || d.status.provider_state || undefined,
    };
  },
  columns: [
    {
      key: 'deployment',
      header: <Trans>Deployment</Trans>,
      cell: (d) => <span className="truncate font-medium text-foreground">{d.name}</span>,
      className: 'w-[45%] max-w-0',
    },
    {
      key: 'status',
      header: <Trans>Provider</Trans>,
      cell: (d) => (
        <StatusDot active={isLiveDeployment(d)}>{d.target.provider || d.status.provider_state || '—'}</StatusDot>
      ),
    },
    {
      key: 'funding',
      header: <Trans>Funded by</Trans>,
      cell: (d) => <FundedBy deployment={d} />,
      className: 'w-[30%] max-w-0',
    },
  ],
};
