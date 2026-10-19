/**
 * The launch-time process watch is a LEASE the session gives back (B7).
 *
 * The two launch paths used to call `proc.watch()` and drop the release it returns: one
 * permanent count per launch (two on a relaunch), so the store's reference count never reached
 * zero, `/unwatch` was never sent, and the backend kept the socket registered as a watcher of a
 * session that was long closed. Real store, real `AgenticProcess`, the socket reported
 * connected; only the HTTP POST is counted instead of sent.
 */
import { AgenticProcess, apiClient, connectionManager, dataManager, ProcessStatus, TypeId } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasLaunchWatch, holdLaunchWatch, releaseLaunchWatch } from '@src/components/agents/launch-watch';

const PROCESS_ID = '7b1a0c2e-0000-4000-8000-0000000000b7';
const typeId = new TypeId(AgenticProcess.type, PROCESS_ID);

function seedProcess(status = ProcessStatus.RUNNING): AgenticProcess {
  const ref = (dataManager as unknown as { getRef(t: TypeId): { entity: unknown; status: string } }).getRef(typeId);
  const proc = new AgenticProcess({ id: PROCESS_ID, status });
  ref.entity = proc;
  ref.status = 'READY';
  return proc;
}

const count = () => (dataManager as unknown as { watches: { get(t: TypeId): number | undefined } }).watches.get(typeId) ?? 0;
let post: ReturnType<typeof spyPost>;
const spyPost = () => vi.spyOn(apiClient, 'post');
const posts = (suffix: string) => post.mock.calls.filter(([url]) => String(url).endsWith(suffix)).length;
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(async () => {
  await dataManager.clearCache();
  vi.spyOn(connectionManager, 'connected', 'get').mockReturnValue(true);
  post = spyPost().mockResolvedValue(undefined as never);
});

afterEach(() => {
  releaseLaunchWatch(PROCESS_ID);
  vi.restoreAllMocks();
});

describe('launch watch lease', () => {
  it('holds ONE count per process, however many times the process is launched', async () => {
    const proc = seedProcess();
    holdLaunchWatch(proc);
    holdLaunchWatch(proc);
    await settle();
    expect(count()).toBe(1);
    expect(posts('/watch')).toBe(1);
    expect(hasLaunchWatch(PROCESS_ID)).toBe(true);
  });

  it('takes no lease on a process that already ended — nothing would give it back', async () => {
    holdLaunchWatch(seedProcess(ProcessStatus.STOPPED));
    await settle();
    expect(hasLaunchWatch(PROCESS_ID)).toBe(false);
    expect(count()).toBe(0);
    expect(posts('/watch')).toBe(0);
  });

  it('gives the count back on release, and the store tells the backend once', async () => {
    const proc = seedProcess();
    holdLaunchWatch(proc);
    await settle();
    releaseLaunchWatch(PROCESS_ID);
    releaseLaunchWatch(PROCESS_ID); // a second release is inert
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
    expect(hasLaunchWatch(PROCESS_ID)).toBe(false);
  });

  it('a release before the watch POST answers still ends at zero', async () => {
    const proc = seedProcess();
    let answer: () => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (answer = () => r(undefined as never))));
    holdLaunchWatch(proc);
    releaseLaunchWatch(PROCESS_ID);
    expect(hasLaunchWatch(PROCESS_ID)).toBe(false);
    answer();
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('the process ending releases the lease by itself — no view had to open', async () => {
    const proc = seedProcess(ProcessStatus.STARTING);
    holdLaunchWatch(proc);
    await settle();
    expect(count()).toBe(1);
    // The backend's save after the PTY exited, as the store applies it.
    (dataManager as unknown as { onDataOp(t: string, op: string, d: object): void }).onDataOp(typeId.toString(), 'update', {
      type: AgenticProcess.type,
      id: PROCESS_ID,
      status: ProcessStatus.STOPPED,
    });
    await settle();
    expect(hasLaunchWatch(PROCESS_ID)).toBe(false);
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('the view does not inherit the lease: its own watch balances separately', async () => {
    const proc = seedProcess();
    holdLaunchWatch(proc);
    const viewRelease = await proc.watch();
    expect(count()).toBe(2);
    await viewRelease();
    expect(count()).toBe(1); // the lease is still held
    releaseLaunchWatch(PROCESS_ID);
    await settle();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });
});
