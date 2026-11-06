import { Agent, ComputeNode, Deployment, ExecutionEnvironmentStatus, PageId, ViewType, isHubOnly } from '@sdk';
import { DockPointer, NODE_PARAM } from '@src/navigation/DockPointer';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { isLaunched, useSandboxes } from '@src/hooks/use-sandboxes';
import { ALL_AGENTS, ALL_DEPLOYMENTS, DEPLOYMENTS_WITH_ROLES, DeploymentBadges, agentCard, deploymentsByAgent, toAgentRows, type AgentRow } from './agent-counters';
import { crossCounters } from './axes';
import { isLiveDeployment, isRunning, runPauseStatuses } from './placement';
import { StatusDot } from './AssetItems';
import type { AssetCounterGroup } from './types';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { deploymentState, type ItemState } from '@src/components/items/item-state';
import { StatePill } from '@src/components/items/ItemCard';
import { roleOf } from '@src/components/items/role';
import { FundedBy } from '@src/components/assets/editor/agent-profile/deployment/DeploymentFunding';

/**
 * The hub home's counters. Org-wide graph queries with no project scope: the
 * hub has no "current project" to count within, only what the caller can reach.
 */


/** A machine plus its probed status (absent until probed, or never launched). */
export interface MachineRow {
  node: ComputeNode;
  status: ExecutionEnvironmentStatus | null;
}

export function isActiveMachine(row: MachineRow): boolean {
  return row.status === ExecutionEnvironmentStatus.READY;
}

const isPausedMachine = (row: MachineRow) => row.status === ExecutionEnvironmentStatus.PAUSED;

/** A machine in the shared state words: unreachable or disconnected asks for you. */
function machineState(row: MachineRow): ItemState {
  switch (row.status) {
    case ExecutionEnvironmentStatus.READY:
      return 'running';
    case ExecutionEnvironmentStatus.PAUSED:
      return 'paused';
    case ExecutionEnvironmentStatus.NEW:
      return 'starting';
    case ExecutionEnvironmentStatus.ERROR:
    case ExecutionEnvironmentStatus.DISCONNECTED:
    case ExecutionEnvironmentStatus.NOT_FOUND:
      return 'attention';
    default:
      return isLaunched(row.node) ? 'starting' : 'off';
  }
}


export const hubAgentCounterGroup: AssetCounterGroup<AgentRow> = {
  id: 'hub-agents',
  type: Agent.type,
  useCounters: () => {
    const { data: agents = [], isLoading } = useEntitiesQuery<Agent>(ALL_AGENTS);
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
  card: agentCard,
  role: (row) => roleOf(row.agent),
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
  // Hub: its Machines screen (open, resume, share). Desk: the machine page for that node.
  itemPointer: (row) =>
    isHubOnly()
      ? new DockPointer(ViewType.MACHINES, '', undefined, undefined, PageId.HUB)
      : new DockPointer(ViewType.MACHINE, '', { [NODE_PARAM]: row.node.id }),
  card: (row) => ({
    title: row.node.name,
    icon: iconForType(ComputeNode.type),
    state: machineState(row),
    role: roleOf(row.node),
    warning: isLaunched(row.node) && !row.node.logged_in_user ? <Trans>Signed out — running with no identity</Trans> : undefined,
    description: row.node.logged_in_user ? <Trans>Signed in as {row.node.logged_in_user}</Trans> : undefined,
    chips: [row.node.node_size, row.node.node_provider_type].filter(Boolean) as string[],
    at: { date: row.node.created_date, verb: 'started' },
  }),
  role: (row) => roleOf(row.node),
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
      cell: (row) => <StatePill state={machineState(row)} />,
    },
  ],
};

export const hubDeploymentCounterGroup: AssetCounterGroup<Deployment> = {
  id: 'hub-deployments',
  type: Deployment.type,
  useCounters: () => {
    const { data: deployments = [], isLoading } = useEntitiesQuery<Deployment>(DEPLOYMENTS_WITH_ROLES);
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
  card: (d) => ({
    title: d.name,
    icon: iconForType(Deployment.type),
    state: deploymentState(d.status?.provider_state),
    role: roleOf(d),
    description: <FundedBy deployment={d} />,
    chips: [d.target.provider, d.environment].filter(Boolean),
    at: { date: d.updated_date },
  }),
  role: roleOf,
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
      cell: (d) => <StatePill state={deploymentState(d.status?.provider_state)} />,
    },
    {
      key: 'funding',
      header: <Trans>Funded by</Trans>,
      cell: (d) => <FundedBy deployment={d} />,
      className: 'w-[30%] max-w-0',
    },
  ],
};
