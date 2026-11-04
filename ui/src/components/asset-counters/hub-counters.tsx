import { Agent, ComputeNode, Deployment, ExecutionEnvironmentStatus, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { isLaunched, useSandboxes } from '@src/hooks/use-sandboxes';
import { ALL_DEPLOYMENTS, DeploymentBadges, deploymentsByAgent, toAgentRows, type AgentRow } from './agent-counters';
import { crossCounters } from './axes';
import { isLiveDeployment, isRunning, runPauseStatuses } from './placement';
import { StatusDot } from './AssetItems';
import type { AssetCounterGroup } from './types';
import { FundedBy } from '@src/components/assets/editor/agent-profile/deployment/DeploymentFunding';

/**
 * The hub home's counters. Org-wide graph queries with no project scope: the
 * hub has no "current project" to count within, only what the caller can reach.
 */

const HUB_AGENTS = new QueryRequest({ type: Agent.type, scope: [], query: null, name: 'hubCounters:agents' });

/** A machine plus its probed status (absent until probed, or never launched). */
export interface MachineRow {
  node: ComputeNode;
  status: ExecutionEnvironmentStatus | null;
}

export function isActiveMachine(row: MachineRow): boolean {
  return row.status === ExecutionEnvironmentStatus.READY;
}

const isPausedMachine = (row: MachineRow) => row.status === ExecutionEnvironmentStatus.PAUSED;

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
      () =>
        crossCounters({
          label: <Trans>Agents</Trans>,
          items: rows,
          isLoading,
          statuses: runPauseStatuses<AgentRow>(isRunning, null, deploymentsLoading),
        }),
      [rows, isLoading, deploymentsLoading],
    );
  },
  itemKey: (row) => row.agent.id,
  searchText: ({ agent }) => [agent.displayName, agent.description].filter(Boolean).join(' '),
  itemPointer: (row) => row.agent.dockPointer,
  card: (row) => {
    const active = isRunning(row);
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
        <StatusDot active={isRunning(row)}>{isRunning(row) ? <Trans>Active</Trans> : <Trans>Idle</Trans>}</StatusDot>
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
      () =>
        crossCounters({
          label: <Trans>Machines</Trans>,
          items: rows,
          isLoading,
          statuses: runPauseStatuses(isActiveMachine, isPausedMachine),
        }),
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
      () =>
        crossCounters({
          label: <Trans>Deployments</Trans>,
          items: deployments,
          isLoading,
          statuses: runPauseStatuses(isLiveDeployment, (d: Deployment) => !isLiveDeployment(d)),
        }),
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
