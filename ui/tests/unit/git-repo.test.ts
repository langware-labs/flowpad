import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataManager, GitWorkdir, GitStatus, ComputeNode } from '@sdk';

const WORKDIR = '/home/user/repo';

describe('GitWorkdir', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getStatus calls git-ops/status with correct ActionInfo and returns GitStatus', async () => {
    const statusData: GitStatus = { error: null, branch: 'main', ahead: 0, behind: 0, files: [] };
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(statusData as any);

    const result = await new GitWorkdir(WORKDIR).getStatus();

    expect(result).toEqual(statusData);
    const actionInfo = spy.mock.calls[0][0];
    expect(actionInfo.name).toBe('git-ops');
    expect(actionInfo.subpath).toBe('status');
    expect(actionInfo.queryParameters).toMatchObject({ workdir: WORKDIR });
    expect(actionInfo.targetEntity?.type).toBe(ComputeNode.type);
  });

  it('getBranch calls git-ops/branch and extracts branch string', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ branch: 'feat/x' } as any);
    expect(await new GitWorkdir(WORKDIR).getBranch()).toBe('feat/x');
  });

  it('getBranch returns null when branch is null', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ branch: null } as any);
    expect(await new GitWorkdir(WORKDIR).getBranch()).toBeNull();
  });

  it('isInit calls git-ops/is-init and reads isInit (camelCase)', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ isInit: true } as any);
    expect(await new GitWorkdir(WORKDIR).isInit()).toBe(true);
  });

  it('isInit defaults to false when isInit missing', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as any);
    expect(await new GitWorkdir(WORKDIR).isInit()).toBe(false);
  });

  it('isLinkedWorktree calls git-ops/is-linked-worktree and reads isLinkedWorktree (camelCase)', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ isLinkedWorktree: true } as any);
    expect(await new GitWorkdir(WORKDIR).isLinkedWorktree()).toBe(true);
  });

  it('isLinkedWorktree defaults to false when isLinkedWorktree missing', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as any);
    expect(await new GitWorkdir(WORKDIR).isLinkedWorktree()).toBe(false);
  });

  it('hasCommit calls git-ops/has-commit and reads hasCommit (camelCase)', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ hasCommit: true } as any);
    expect(await new GitWorkdir(WORKDIR).hasCommit()).toBe(true);
  });

  it('hasCommit defaults to false when hasCommit missing', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as any);
    expect(await new GitWorkdir(WORKDIR).hasCommit()).toBe(false);
  });

  it('uses custom computeNodeId when provided', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ isInit: false } as any);
    await new GitWorkdir(WORKDIR, '@custom').isInit();
    expect(spy.mock.calls[0][0].targetEntity?.id).toBe('@custom');
  });
});
