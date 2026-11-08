import { useMemo } from 'react';
import { Deployment, type Agent } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/** One place an agent answers on: a deployment whose main agent it is. */
export interface AgentPlace {
  deployment: Deployment;
  /** This computer's own deployment. */
  is_local: boolean;
}

/**
 * The deployments an agent is the main agent of — this computer first — for every view that shows where it
 * runs (the Deployments links, the Schedules section, a schedule's "Runs on"). A live query on
 * `main_agent_id`, so a deploy, pause or delete anywhere lands here without a reload.
 */
export function useAgentPlaces(agent: Agent | null | undefined): {
  places: AgentPlace[] | null;
  reload: () => Promise<void>;
} {
  const agentId = agent?.id ?? null;
  const request = useMemo(() => Deployment.forMainAgentQuery(agentId ?? ''), [agentId]);
  const { data, refetch } = useEntitiesQuery<Deployment>(request, { enabled: !!agentId });
  const places = useMemo(
    () =>
      data
        ? data
            .map((deployment) => ({ deployment, is_local: deployment.isLocal }))
            .sort((a, b) => Number(b.is_local) - Number(a.is_local))
        : null,
    [data],
  );
  return { places, reload: refetch };
}
