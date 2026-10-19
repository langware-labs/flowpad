/**
 * `transcript/plan` and `transcript/prompts` parse the whole JSONL transcript on
 * the server. Views that mount on every tab switch asked for them on every
 * switch (measured 2026-09-27: 2 plan + 1 prompts per switch to a terminal).
 * The process answers a repeat from its last read while nothing that changes
 * the answer moved — and re-reads at a turn boundary, a restart, a found plan,
 * or when the caller forces it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, dataManager } from '@sdk';

const ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function proc(): AgenticProcess {
  return new AgenticProcess({ id: ID, status: 'idle', session_id: 's1', shell_id: 'sh1', pty_mode: true } as never);
}

afterEach(() => vi.restoreAllMocks());

describe('transcript reads are answered from the last read while nothing moved', () => {
  it('a repeat is one request; a turn boundary, a restart or force re-reads', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ prompts: [] } as never);
    const p = proc();

    await p.getPrompts();
    await p.getPrompts();
    expect(call).toHaveBeenCalledTimes(1);

    p.status = 'running' as never; // a turn started
    await p.getPrompts();
    expect(call).toHaveBeenCalledTimes(2);

    p.session_id = 's2'; // a restart
    await p.getPrompts();
    expect(call).toHaveBeenCalledTimes(3);

    await p.getPrompts({ force: true }); // the prompt just submitted
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('plan and prompts are cached separately, and a found plan re-reads the plan', async () => {
    const call = vi
      .spyOn(dataManager, 'callAction')
      .mockImplementation((action) =>
        Promise.resolve((action.subpath === 'plan' ? { markdown: null, plan_path: null } : { prompts: [] }) as never),
      );
    const p = proc();
    await p.getPlan();
    await p.getPrompts();
    await p.getPlan();
    expect(call).toHaveBeenCalledTimes(2);

    p.plan_path = '/w/.claude/plans/plan.md';
    await p.getPlan();
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('a failed read is not an answer: the next caller asks again', async () => {
    const call = vi
      .spyOn(dataManager, 'callAction')
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValue({ prompts: [] } as never);
    const p = proc();
    await expect(p.getPrompts()).rejects.toThrow('backend down');
    await p.getPrompts();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
