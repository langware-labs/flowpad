/**
 * Perf hunt 2026-11-07 (B2/B4): the footer git pill remounts on every project switch, and each
 * mount ran a network ``git fetch`` (2-3 s). Mounts now share one fetch per working tree for the
 * poll interval; the poll and an explicit refresh force a new one, and a failure is not kept.
 */
import { describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ calls: 0, next: { error: null, behind: 2 } as Record<string, unknown> | null }));
vi.mock('@src/lib/git-outcome', () => ({ closeGitConflict: vi.fn() }));
vi.mock('@sdk', () => ({
  GitWorkdir: class {
    fetch() {
      net.calls++;
      return Promise.resolve(net.next);
    }
  },
}));

import { getGitFetch } from '@src/lib/git-status-cache';

describe('getGitFetch', () => {
  it('reuses one fetch across mounts, refetches when forced, never keeps a failure', async () => {
    expect(await getGitFetch('n', '/a')).toMatchObject({ behind: 2 });
    await getGitFetch('n', '/a');
    expect(net.calls).toBe(1);

    await getGitFetch('n', '/a', { force: true });
    expect(net.calls).toBe(2);

    net.next = { error: 'offline' };
    await getGitFetch('n', '/b');
    await new Promise((r) => setTimeout(r, 0));
    await getGitFetch('n', '/b');
    expect(net.calls).toBe(4);
  });
});
