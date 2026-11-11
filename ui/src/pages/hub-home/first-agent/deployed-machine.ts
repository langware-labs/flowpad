import { dataManager, Deployment, type DeployedAgent, Onboarding, TypeId } from '@sdk';
import { isTerminal, type ActivityProgressSpec } from '@sdk/activity';
import { releaseWhenWatched } from '@sdk/process/watch-lease';
import { getActivity, subscribeToActivities } from '@src/store/activity-store';

/**
 * Deploy the agent's project with the agent as main, and answer its machine. The hub answers with the machine;
 * this computer answers before it (`deployment_id`, the project's `deploy` activity), so that activity is
 * watched from before the deploy until it ends, and the machine is then its placement's.
 */
export async function deployedMachine(projectId: string, agentId: string): Promise<DeployedAgent> {
  const subject = `project-${projectId}`;
  const watching = dataManager.watch(new TypeId('project', projectId));
  try {
    const answer: DeployedAgent & { deployment_id?: string } = await Onboarding.deploy(projectId, agentId);
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
    const origin = (await Deployment.getById<Deployment>(deploymentId))?.origin;
    if (!origin?.external_id) throw new Error('the deployment has no machine');
    return { node_typeid: origin.external_id, deployment: { id: deploymentId } };
  } finally {
    releaseWhenWatched(watching);
  }
}
