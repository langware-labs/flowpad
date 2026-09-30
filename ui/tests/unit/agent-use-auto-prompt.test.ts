/**
 * FLOWPAD-2180 — `Agent.use` / `useDeployment` ask the backend for the agent's
 * auto prompt only when the caller opts in. External SDK pages that never
 * drain the queue keep today's behaviour: no `auto_prompt` in the body.
 */
import { Agent, dataManager } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AGENT_ID = '5f0e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

/** Stub the SDK transport and return a reader for the bodies each call sent. */
function recordCalls(): () => Record<string, unknown>[] {
  const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ process_id: 'p-1' } as never);
  return () => spy.mock.calls.map(([info]) => (info as { bodyParameters?: Record<string, unknown> }).bodyParameters ?? {});
}

afterEach(() => vi.restoreAllMocks());

describe('Agent.use auto prompt opt-in', () => {
  it('sends no auto_prompt unless asked', async () => {
    const sentBodies = recordCalls();
    const agent = new Agent({ id: AGENT_ID, name: 'greeter' } as never);

    await agent.use('proj-1');
    await agent.useDeployment('dep-1');

    expect(sentBodies()).toEqual([{ project_id: 'proj-1' }, { deployment_id: 'dep-1' }]);
  });

  it('sends auto_prompt: true when the caller opts in', async () => {
    const sentBodies = recordCalls();
    const agent = new Agent({ id: AGENT_ID, name: 'greeter' } as never);

    await agent.use('proj-1', { autoPrompt: true });
    await agent.useDeployment('dep-1', { autoPrompt: true });

    expect(sentBodies()).toEqual([
      { project_id: 'proj-1', auto_prompt: true },
      { deployment_id: 'dep-1', auto_prompt: true },
    ]);
  });
});
