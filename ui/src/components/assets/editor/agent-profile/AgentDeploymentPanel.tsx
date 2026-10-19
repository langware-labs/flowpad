import { useEffect, useState } from 'react';
import { Agent, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { AgentPlaceCard } from './AgentPlaceCard';
import { useAgentPlaces } from './use-agent-places';

/**
 * An agent's deployment, on the deployment's own page (WorldView's details for it): what runs
 * there (Activity), how it runs there (Config — worker, model, permissions, effort), a Chat with
 * it, and its on/off, update and pause. The agent page only lists deployments; this is where one
 * is looked at and set.
 */
export function AgentDeploymentPanel({ agentId, deploymentId }: { agentId: string; deploymentId: string }) {
  const { data: agent } = useEntity<Agent>(new TypeId(Agent.type, agentId));
  const { places, reload } = useAgentPlaces(agent);
  const place = places?.find((p) => p.deployment.id === deploymentId) ?? null;
  // This computer's version pill counts what is not published yet.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!agent || !place?.is_local) return;
    let live = true;
    agent
      .versionState()
      .then((v) => live && setPending(v.pending_changes ?? 0))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent, place?.is_local]);

  if (!agent || !place) return null;
  return (
    <div className="section" data-testid="worldview-agent-deployment">
      <AgentPlaceCard agent={agent} place={place} pendingChanges={pending} onChanged={reload} />
    </div>
  );
}
