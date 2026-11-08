/**
 * Every mounted `useSandboxes` (hub home mounts several) reads a box's status through ONE shared
 * read, so a page load costs one `ops/status` per box — not one per hook instance. Prod saw
 * 27 boxes × ~10 instances = 270 hub calls per load of hub home.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputeNode, ExecutionEnvironmentStatus } from '@sdk';
import { readSandboxStatus, resetSandboxStatusCache } from '@src/hooks/use-sandboxes';

const NODE_ID = '11111111-2222-4333-8444-555555555555';

function node() {
  const n = new ComputeNode({ id: NODE_ID, name: 'box' });
  const status = vi.spyOn(n, 'status').mockResolvedValue({ status: ExecutionEnvironmentStatus.READY });
  return { n, status };
}

describe('shared sandbox status read', () => {
  afterEach(() => resetSandboxStatusCache());

  it('answers many readers of one box with one status call', async () => {
    const { n, status } = node();
    const answers = await Promise.all(Array.from({ length: 8 }, () => readSandboxStatus(n)));
    expect(status).toHaveBeenCalledTimes(1);
    expect(answers.every((a) => a.status === ExecutionEnvironmentStatus.READY)).toBe(true);
    await readSandboxStatus(n);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('a forced read (the machine poll) asks again', async () => {
    const { n, status } = node();
    await readSandboxStatus(n);
    await readSandboxStatus(n, true);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('a failed probe reads as an error, never a throw', async () => {
    const n = new ComputeNode({ id: NODE_ID, name: 'box' });
    vi.spyOn(n, 'status').mockRejectedValue(new Error('down'));
    expect((await readSandboxStatus(n)).status).toBe(ExecutionEnvironmentStatus.ERROR);
  });
});
