import { useMemo } from 'react';
import { Agent, AgenticProcess, Deployment, TypeId, isTypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';

/** What a process says about who launched it. */
type LaunchedProcess = Pick<AgenticProcess, 'deployment_id' | 'target_typeid_str'>;

/**
 * The Agent a process was launched through, or null.
 *
 * A session opened as an agent (`Deployment.use`) names it in `target_typeid_str` — the
 * deployment it runs on may launch a different agent than its main one (`with_agent`), so
 * that wins. Otherwise `deployment_id` → `Deployment.mainAgentTypeId`. Every hop goes
 * through `useEntity` (cache-first, live-updating — a rename or a new avatar repaints).
 *
 * `enabled` lets a caller that only shows the agent on demand (the Assets
 * popover) defer the lookups until it is open; the execution panel, which
 * signs every turn with it, leaves it on.
 */
export function useLaunchingAgent(
  process: LaunchedProcess | null | undefined,
  options?: { enabled?: boolean },
): Agent | null {
  const enabled = options?.enabled !== false;
  const target = process?.target_typeid_str ?? null;
  const namedAgent = useMemo(() => {
    if (!target || !isTypeId(target)) return null;
    const typeId = new TypeId(target);
    return typeId.type === Agent.type ? typeId : null;
  }, [target]);
  const deploymentId = namedAgent ? null : (process?.deployment_id ?? null);
  const deploymentTypeId = useMemo(
    () => (deploymentId ? new TypeId(Deployment.type, deploymentId) : null),
    [deploymentId],
  );
  const deployment = useEntity<Deployment>(deploymentTypeId, { enabled }).data;
  const agentTypeId = namedAgent ?? deployment?.mainAgentTypeId ?? null;
  return useEntity<Agent>(agentTypeId, { enabled }).data ?? null;
}

/**
 * The vibe-only Agent (`Agent.vibe_only`) the session `processId` was launched
 * through, or null. Such a session stays in Vibe: no tab strip, no surface switch.
 */
export function useVibeOnlyAgent(processId: string | null | undefined): Agent | null {
  const typeId = useMemo(() => (processId ? new TypeId(AgenticProcess.type, processId) : null), [processId]);
  const process = useEntity<AgenticProcess>(typeId).data;
  const agent = useLaunchingAgent(process);
  return agent?.vibe_only ? agent : null;
}
