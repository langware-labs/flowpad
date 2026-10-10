/**
 * A conflict toast is sticky and the resolver finishes outside the UI, so the
 * status cache — where every status read lands — takes it down: the first
 * status that sees the tree clean closes it. The footer re-reads on window
 * focus, so a resolved conflict doesn't wait for the 10-minute poll.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.hoisted(() => ({ next: null as Record<string, unknown> | null, calls: 0 }));
const closeMock = vi.hoisted(() => vi.fn());

vi.mock('@src/lib/git-outcome', () => ({ closeGitConflict: closeMock }));
vi.mock('@sdk', () => ({
  fsManager: { onFileWritten: () => () => {} },
  GitWorkdir: class {
    getStatus() {
      statusMock.calls++;
      return Promise.resolve(statusMock.next);
    }
    fetch() {
      return Promise.resolve(null);
    }
  },
}));

import { getGitStatus, invalidateGitStatus } from '@src/lib/git-status-cache';
import { useGitChangeCount } from '@src/hooks/use-git-change-count';

const status = (conflict: unknown) => ({ error: null, branch: 'main', ahead: 0, behind: 0, files: [], conflict });

afterEach(() => {
  closeMock.mockReset();
  statusMock.calls = 0;
  invalidateGitStatus('node-1', '/repo');
});

describe('a resolved conflict closes its toast', () => {
  it('the status cache closes it on a clean status, never on a stuck or failed one', async () => {
    statusMock.next = status({ paths: ['a.md'], operation: 'rebase' });
    await getGitStatus('node-1', '/repo', { force: true });
    statusMock.next = { error: 'not a git repository' };
    await getGitStatus('node-1', '/repo', { force: true });
    expect(closeMock).not.toHaveBeenCalled();

    statusMock.next = status(null);
    await getGitStatus('node-1', '/repo', { force: true });
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('/repo'));
  });

  it('the footer re-reads on window focus', async () => {
    statusMock.next = status({ paths: ['a.md'], operation: 'rebase' });
    const { result } = renderHook(() => useGitChangeCount('node-1', '/repo'));
    await waitFor(() => expect(result.current.conflict).not.toBeNull());

    statusMock.next = status(null);
    invalidateGitStatus('node-1', '/repo');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(result.current.conflict).toBeNull());
    expect(closeMock).toHaveBeenCalledWith('/repo');
  });
});
