import { Agent, dataManager, type DeployedAgent, Onboarding, TypeId } from '@sdk';
import { isTerminal, type ActivityProgressSpec } from '@sdk/activity';
import { releaseWhenWatched } from '@sdk/process/watch-lease';
import { getActivity, subscribeToActivities } from '@src/store/activity-store';

/**
 * Deploy the agent and answer its machine. The hub answers with the machine; this computer answers before it
 * (`deployment_id`, the agent's `deploy` activity), so that activity is watched from before the deploy until it
 * ends, and the machine is then its placement's. Both answer a watch: it is asked for either way.
 */
export async function deployedMachine(agentId: string): Promise<DeployedAgent> {
  const subject = `agent-${agentId}`;
  const watching = dataManager.watch(new TypeId('agent', agentId));
  try {
    const answer: DeployedAgent & { deployment_id?: string } = await Onboarding.deploy(agentId);
    const deploymentId = answer.deployment_id;
    if (answer.node_typeid || !deploymentId) return answer;
    const ended = await new Promise<ActivityProgressSpec>((resolve) => {
      let stop = (): void => undefined;
      const check = () => {
        const spec = getActivity('deploy', subject);
        if (!spec || !isTerminal(spec)) return;
        stop();
        resolve(spec);
      };
      stop = subscribeToActivities(check);
      check();
    });
    if (ended.state !== 'completed') throw new Error(ended.message || `the deploy ${ended.state}`);
    const places = await (await Agent.getById(agentId))?.listPlaces();
    const origin = places?.find((place) => place.deployment.id === deploymentId)?.deployment.origin as
      | { external_id?: string }
      | null
      | undefined;
    if (!origin?.external_id) throw new Error('the deployment has no machine');
    return { node_typeid: origin.external_id, deployment: { id: deploymentId } };
  } finally {
    releaseWhenWatched(watching);
  }
}
