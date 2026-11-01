/**
 * The first-agent card needs its agent's machine. The hub answers the deploy with it; this computer answers before
 * the machine (`deployment_id` and the `deploy` activity), so the machine is read once that activity has ended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, dataManager, Onboarding } from '@sdk';
import type { ActivityProgressSpec, ActivityState } from '@sdk/activity';
import { __resetActivityStoreForTest, handleActivitySnapshot } from '@src/store/activity-store';

const hub = vi.hoisted(() => ({ only: false }));
vi.mock('@sdk/utils/hub-runtime', () => ({ isHubOnly: () => hub.only }));

import { deployedMachine } from '@src/pages/hub-home/first-agent/deployed-machine';

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const NODE = 'compute_node-4166cfc6-453f-441d-a777-aefd68bb8b2a';

const report = (state: ActivityState, message: string | null = null) =>
  ({
    activity_id: 'a-1', subject_entity: `agent-${AGENT_ID}`, path: 'deploy', name: 'deploy', label: 'deploy', state,
    message, done: 0, skipped: 0, errors_count: 0, errors: [], counters: {}, children: [], seq: state === 'running' ? 1 : 2,
  }) as ActivityProgressSpec;

function desktop() {
  const release = vi.fn().mockResolvedValue(undefined);
  const watch = vi.spyOn(dataManager, 'watch').mockReturnValue(Promise.resolve(release) as never);
  const deploy = vi.spyOn(Onboarding, 'deploy').mockResolvedValue({
    agent_id: AGENT_ID,
    activity: { path: 'deploy', subject_entity: `agent-${AGENT_ID}` },
    deployment_id: 'dep-1',
  } as never);
  const places = vi.fn().mockResolvedValue([{ deployment: { id: 'dep-1', origin: { external_id: NODE } } }]);
  vi.spyOn(Agent, 'getById').mockResolvedValue({ listPlaces: places } as never);
  return { watch, release, places, deploy };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetActivityStoreForTest();
  hub.only = false;
});

describe('deployedMachine', () => {
  it('on this computer, watches the agent from before the deploy and answers its placement’s machine once it ends', async () => {
    const { watch, release, places, deploy } = desktop();
    handleActivitySnapshot(report('running'));

    const machine = deployedMachine(AGENT_ID);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalled());
    expect(watch.mock.invocationCallOrder[0]).toBeLessThan(deploy.mock.invocationCallOrder[0]);
    expect(places).not.toHaveBeenCalled();

    handleActivitySnapshot(report('completed'));

    await expect(machine).resolves.toEqual({ node_typeid: NODE, deployment: { id: 'dep-1' } });
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
  });

  it('a deploy that fails is the error, with its reason', async () => {
    const { deploy } = desktop();
    handleActivitySnapshot(report('running'));

    const machine = deployedMachine(AGENT_ID);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalled());
    handleActivitySnapshot(report('failed', 'the provider is out of machines'));

    await expect(machine).rejects.toThrow('the provider is out of machines');
  });

  it('on the hub, the answer is the machine: nothing is watched or waited for', async () => {
    hub.only = true;
    const watch = vi.spyOn(dataManager, 'watch');
    vi.spyOn(Onboarding, 'deploy').mockResolvedValue({ node_typeid: NODE, deployment: { id: 'dep-1' } });

    await expect(deployedMachine(AGENT_ID)).resolves.toEqual({ node_typeid: NODE, deployment: { id: 'dep-1' } });
    expect(watch).not.toHaveBeenCalled();
  });
});
