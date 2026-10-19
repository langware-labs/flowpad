/**
 * The SDK owns "watch until the process ends" (F1).
 *
 * `dataManager.watch` is reference-counted and only the release it returns decrements it. A
 * caller with no view to keep that release — `createProcess`'s default, a headless `spawn` —
 * takes a LEASE instead (`AgenticProcess.watchWhileLive`): one per process, given back when the
 * process stops or fails, on an explicit release, or when the store drops the entity. Real
 * store, real `AgenticProcess` / `ComputeNode`, the socket reported connected; only the HTTP
 * calls are counted instead of sent.
 */
import { AgenticProcess, ComputeNode, connectionManager, dataManager, ProcessStatus } from '@sdk';
import { posts, settle, spyPost, store, watchedProcess } from './watch_test_utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '7b1a0c2e-0000-4000-8000-0000000000f1';
const { typeId, count, seedProcess } = watchedProcess(PROCESS_ID);

/** The backend's save, as the store applies it. */
const pushStatus = (status: ProcessStatus) =>
  store.onDataOp(typeId.toString(), 'update', { type: AgenticProcess.type, id: PROCESS_ID, status });

let post: ReturnType<typeof spyPost>;

beforeEach(async () => {
  await dataManager.clearCache();
  vi.spyOn(connectionManager, 'connected', 'get').mockReturnValue(true);
  post = spyPost().mockResolvedValue(undefined as never);
});

afterEach(() => {
  AgenticProcess.releaseLiveWatch(PROCESS_ID);
  vi.restoreAllMocks();
});

describe('AgenticProcess.watchWhileLive', () => {
  it('holds ONE count per process and resolves once the watch is registered', async () => {
    const proc = seedProcess();
    const first = proc.watchWhileLive();
    const second = proc.watchWhileLive();
    await Promise.all([first, second]);
    expect(count()).toBe(1);
    expect(posts('/watch')).toBe(1);
    expect(AgenticProcess.hasLiveWatch(PROCESS_ID)).toBe(true);
  });

  it('takes no lease on a process that already ended', async () => {
    await seedProcess(ProcessStatus.FAILED).watchWhileLive();
    expect(AgenticProcess.hasLiveWatch(PROCESS_ID)).toBe(false);
    expect(count()).toBe(0);
    expect(posts('/watch')).toBe(0);
  });

  it('the process ending gives the count back and tells the backend once', async () => {
    await seedProcess(ProcessStatus.NEW).watchWhileLive();
    pushStatus(ProcessStatus.RUNNING);
    await settle();
    expect(count()).toBe(1);
    pushStatus(ProcessStatus.STOPPED);
    await settle();
    expect(AgenticProcess.hasLiveWatch(PROCESS_ID)).toBe(false);
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('every other status listener still hears the end the lease releases on', async () => {
    const proc = seedProcess();
    await proc.watchWhileLive();
    const heard: ProcessStatus[] = [];
    proc.on('status', (status: ProcessStatus) => heard.push(status));
    proc.on('status', (status: ProcessStatus) => heard.push(status));
    pushStatus(ProcessStatus.STOPPED);
    await settle();
    expect(heard).toEqual([ProcessStatus.STOPPED, ProcessStatus.STOPPED]);
    expect(count()).toBe(0);
  });

  it('an explicit release before the watch POST answers still ends at zero', async () => {
    const proc = seedProcess();
    let answer: () => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (answer = () => r(undefined as never))));
    void proc.watchWhileLive();
    AgenticProcess.releaseLiveWatch(PROCESS_ID);
    AgenticProcess.releaseLiveWatch(PROCESS_ID); // a second release is inert
    answer();
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('a failed watch does not leave a lease behind', async () => {
    const proc = seedProcess();
    vi.spyOn(proc, 'watch').mockRejectedValueOnce(new Error('no route'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await proc.watchWhileLive();
    await settle();
    expect(warn).toHaveBeenCalled();
    expect(AgenticProcess.hasLiveWatch(PROCESS_ID)).toBe(false);
  });

  it('the store dropping the entity drops its lease and its count', async () => {
    await seedProcess().watchWhileLive();
    expect(count()).toBe(1);
    await dataManager.clearCache();
    await settle();
    expect(AgenticProcess.hasLiveWatch(PROCESS_ID)).toBe(false);
    expect(count()).toBe(0);
    // The row is gone from this client; there is nothing to un-watch on the backend.
    expect(posts('/unwatch')).toBe(0);
  });
});

describe('ComputeNode.createProcess', () => {
  const created = { type: AgenticProcess.type, id: PROCESS_ID, status: ProcessStatus.NEW, pty_mode: false };

  it('watches the new process by default, and the count is back at zero once it ends', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(created as never);
    const proc = await new ComputeNode({ id: '@local' }).createProcess({}, { visible: false, pty_mode: false });
    // Registered before createProcess returns: the caller prompts next.
    expect(count()).toBe(1);
    expect(posts('/watch')).toBe(1);

    // First-turn status reaches the entity with no view watching.
    pushStatus(ProcessStatus.RUNNING);
    expect(proc.status).toBe(ProcessStatus.RUNNING);
    expect(count()).toBe(1);

    pushStatus(ProcessStatus.STOPPED);
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('a view that mounted meanwhile keeps the process watched after the lease is gone', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(created as never);
    const proc = await new ComputeNode({ id: '@local' }).createProcess({}, { visible: false, pty_mode: false });
    const viewRelease = await proc.watch();
    pushStatus(ProcessStatus.STOPPED);
    await settle();
    expect(count()).toBe(1); // the view's own
    expect(posts('/unwatch')).toBe(0);
    await viewRelease();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('watchProcess: false takes no watch at all', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(created as never);
    await new ComputeNode({ id: '@local' }).createProcess({}, { watchProcess: false });
    expect(count()).toBe(0);
    expect(posts('/watch')).toBe(0);
  });
});
