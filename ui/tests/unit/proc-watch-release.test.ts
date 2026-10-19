/**
 * A workflow node's process watch is given back when its slot is freed, however early (F1).
 *
 * `started` watches the spawned process, `finished` / `failed` releases it. The release only
 * exists once the `/watch` POST answers, and the process itself only once it has loaded, so a
 * node that finishes before either must still leave the count at zero. Real store, real
 * `AgenticProcess`, the studio's real store; only the HTTP POST is held and counted.
 */
import { connectionManager, dataManager } from '@sdk';
import type { NodeStatusPayload } from '@sdk/services/graph-workflows';
import { handleNodeStatusForProcWatch } from '@src/components/graph-workflows/proc-watch';
import { posts, settle, spyPost, watchedProcess } from './watch_test_utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '7b1a0c2e-0000-4000-8000-0000000000f5';
const { count, seedProcess } = watchedProcess(PROCESS_ID);

let post: ReturnType<typeof spyPost>;
const node = (phase: string) =>
  handleNodeStatusForProcWatch({ phase, detail: { process_id: PROCESS_ID } } as unknown as NodeStatusPayload);

beforeEach(async () => {
  await dataManager.clearCache();
  seedProcess();
  vi.spyOn(connectionManager, 'connected', 'get').mockReturnValue(true);
  post = spyPost().mockResolvedValue(undefined as never);
});

afterEach(() => {
  node('finished');
  vi.restoreAllMocks();
});

describe('workflow node process watch', () => {
  it('started watches once, finished gives it back', async () => {
    node('started');
    node('started');
    await settle();
    expect(count()).toBe(1);
    node('finished');
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('a node that fails before the watch POST answers still ends at zero', async () => {
    let answer: () => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (answer = () => r(undefined as never))));
    node('started');
    await settle(); // the process has loaded; its watch is waiting on the POST
    expect(count()).toBe(1);
    node('failed');
    answer();
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('a node that finishes before its process has loaded takes no watch', async () => {
    node('started');
    node('finished');
    await settle();
    expect(count()).toBe(0);
    expect(posts('/watch')).toBe(0);
  });
});
