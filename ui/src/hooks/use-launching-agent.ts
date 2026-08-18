import { useMemo } from 'react';
import { Agent, Deployment, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';

/**
 * The Agent a process was launched through, or null.
 *
 * `AgenticProcess.deployment_id` → `Deployment.agentTypeId` → `Agent`, both
 * hops through `useEntity` (cache-first, live-updating — a rename or a new
 * avatar repaints). A process with no deployment issues no request at all.
 *
 * `enabled` follows the caller's popover state, like `useProcessAssets`: the
 * row this feeds only renders inside the open list, so a closed toolbar must
 * not pay for it.
 */
export function useLaunchingAgent(deploymentId: string | null | undefined, options?: { enabled?: boolean }): Agent | null {
  const enabled = options?.enabled !== false;
  const deploymentTypeId = useMemo(
    () => (deploymentId ? new TypeId(Deployment.type, deploymentId) : null),
    [deploymentId],
  );
  const deployment = useEntity<Deployment>(deploymentTypeId, { enabled }).data;
  const agentTypeId = deployment?.agentTypeId ?? null;
  return useEntity<Agent>(agentTypeId, { enabled }).data ?? null;
}
