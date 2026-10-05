/**
 * `useProjectGitShare` — the project page's read of its git share, and the verbs.
 *
 * An unlinked project is never asked (it has no members to share with); a linked
 * one is read once; a failed read keeps the backend's words; `enable()` returns
 * and keeps the hub's answer, including a GitHub step the caller must show.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitShare, Project } from '@sdk';
import { useProjectGitShare } from '@src/hooks/use-project-git-share';

const share = (status: GitShare['status']): GitShare => ({
  status,
  repo: 'acme/api',
  git_repo: null,
  clone_url: null,
  install_url: null,
  default_branch: 'main',
});

function project(remote: boolean) {
  return {
    id: 'p1',
    remote,
    gitShare: vi.fn().mockResolvedValue(share('not_shared')),
    shareGit: vi.fn().mockResolvedValue(share('install_required')),
    unshareGit: vi.fn().mockResolvedValue(share('not_shared')),
  };
}

describe('useProjectGitShare', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks nothing of an unlinked project', () => {
    const p = project(false);
    const { result } = renderHook(() => useProjectGitShare(p as unknown as Project));
    expect(result.current.share).toBeNull();
    expect(p.gitShare).not.toHaveBeenCalled();
  });

  it('reads a linked project once, and keeps a failed read in the backend’s words', async () => {
    const p = project(true);
    p.gitShare.mockRejectedValueOnce({ response: { data: { message: 'hub unreachable' } } });
    const { result } = renderHook(() => useProjectGitShare(p as unknown as Project));
    await waitFor(() => expect(result.current.error).toBe('hub unreachable'));
    expect(result.current.loading).toBe(false);
    expect(p.gitShare).toHaveBeenCalledTimes(1);
  });

  it('enable() returns and keeps the hub’s answer, GitHub step included', async () => {
    const p = project(true);
    const { result } = renderHook(() => useProjectGitShare(p as unknown as Project));
    await waitFor(() => expect(result.current.share?.status).toBe('not_shared'));
    let answer: GitShare | null = null;
    await act(async () => {
      answer = await result.current.enable();
    });
    expect(answer).toMatchObject({ status: 'install_required' });
    expect(result.current.share?.status).toBe('install_required');
    expect(result.current.busy).toBe(false);
  });
});
