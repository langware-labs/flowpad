import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  pending: [] as Array<(value: unknown) => void>,
  getStatus: vi.fn(),
}));

vi.mock('@sdk', () => ({
  GitWorkdir: class {
    getStatus() {
      gitMocks.getStatus();
      return new Promise((resolve) => gitMocks.pending.push(resolve));
    }
  },
}));

import { getGitStatus, invalidateGitStatus } from '@src/lib/git-status-cache';

const STATUS = { error: null, branch: 'main', ahead: 0, behind: 0, files: [] };

// Each test uses its own workdir: the cache is module state.
describe('git-status-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gitMocks.pending = [];
    gitMocks.getStatus.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a request slower than the TTL is still shared by a caller arriving after the TTL', async () => {
    const first = getGitStatus('@local', '/slow');
    await vi.advanceTimersByTimeAsync(3500);
    const second = getGitStatus('@local', '/slow');

    expect(gitMocks.getStatus).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    gitMocks.pending[0](STATUS);
    await expect(first).resolves.toBe(STATUS);
    // The TTL starts at settle: shortly after, the result is still served.
    await vi.advanceTimersByTimeAsync(2000);
    expect(getGitStatus('@local', '/slow')).toBe(first);
    expect(gitMocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('invalidation during flight is not undone when the request settles', async () => {
    const first = getGitStatus('@local', '/invalidated');
    invalidateGitStatus('@local', '/invalidated');
    gitMocks.pending[0](STATUS);
    await first;

    const next = getGitStatus('@local', '/invalidated');
    expect(next).not.toBe(first);
    expect(gitMocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("a superseded request's eviction does not drop the refetch that replaced it", async () => {
    const first = getGitStatus('@local', '/superseded');
    const refetch = getGitStatus('@local', '/superseded', { force: true });
    gitMocks.pending[0](STATUS);
    await first;
    // The first request's TTL elapses while the refetch is still in flight.
    await vi.advanceTimersByTimeAsync(3500);

    expect(getGitStatus('@local', '/superseded')).toBe(refetch);
    expect(gitMocks.getStatus).toHaveBeenCalledTimes(2);
  });
});
