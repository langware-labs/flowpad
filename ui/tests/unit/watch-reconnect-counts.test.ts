/**
 * A reconnect re-registers every watched key WITHOUT touching its count (F1).
 *
 * The backend loses its watch registrations with the socket, so each watched key is POSTed
 * again on `on_open`. The count is the number of holders and stays what it was: were it reset
 * to one, the first of two holders to release would un-watch under the other. Real store, real
 * connection manager (its `on_open` is emitted, the socket reported connected); only the HTTP
 * POST is counted instead of sent.
 */
import { connectionManager, dataManager } from '@sdk';
import { posts, settle, spyPost, watchedProcess } from './watch_test_utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '7b1a0c2e-0000-4000-8000-0000000000f4';
const { typeId, count, seedProcess } = watchedProcess(PROCESS_ID);

let post: ReturnType<typeof spyPost>;
const reconnect = () => connectionManager.emit('on_open');

beforeEach(async () => {
  await dataManager.clearCache();
  seedProcess();
  vi.spyOn(connectionManager, 'connected', 'get').mockReturnValue(true);
  post = spyPost().mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('watch counts across a reconnect', () => {
  it('two holders, a reconnect, one release: still watched, no /unwatch sent', async () => {
    const releaseA = await dataManager.watch(typeId);
    const releaseB = await dataManager.watch(typeId);
    expect(count()).toBe(2);
    expect(posts('/watch')).toBe(1);

    reconnect();
    await settle();
    expect(count()).toBe(2);
    expect(posts('/watch')).toBe(2); // once per key, not once per holder

    await releaseA();
    expect(count()).toBe(1);
    expect(posts('/unwatch')).toBe(0);

    await releaseB();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('a release DURING the reconnect POST leaves the other holder watched', async () => {
    const releaseA = await dataManager.watch(typeId);
    const releaseB = await dataManager.watch(typeId);
    let answer: () => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (answer = () => r(undefined as never))));

    reconnect();
    await releaseA(); // the re-registration has not answered yet
    expect(count()).toBe(1);
    answer();
    await settle();
    expect(count()).toBe(1);
    expect(posts('/unwatch')).toBe(0);

    await releaseB();
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('the last holder leaving during the reconnect POST un-watches AFTER it, exactly once', async () => {
    const release = await dataManager.watch(typeId);
    let answer: () => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (answer = () => r(undefined as never))));

    reconnect();
    const released = release();
    await settle();
    expect(count()).toBe(0);
    // The backend must see /watch before /unwatch, or it is left registered for nobody.
    expect(posts('/unwatch')).toBe(0);
    answer();
    await released;
    expect(posts('/unwatch')).toBe(1);
    expect(post.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['watch', 'watch', 'unwatch']);
  });

  it('a key nobody holds any more is not re-registered', async () => {
    const release = await dataManager.watch(typeId);
    await release();
    reconnect();
    await settle();
    expect(count()).toBe(0);
    expect(posts('/watch')).toBe(1);
  });
});
