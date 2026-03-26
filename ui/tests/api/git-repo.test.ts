import { GitRepo, ComputeNode, dataContext, ShellInputFlowData } from '@sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('GitRepo (live server)', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  afterAll(async () => {});

  function getComputeNode(): ComputeNode {
    const cn = dataContext.computeNode;
    if (!cn) throw new Error('No compute node in context');
    return cn;
  }

  async function shell(cn: ComputeNode, cmd: string): Promise<string> {
    const out = await cn.executeCommand(new ShellInputFlowData(cmd, 'git-repo-test'));
    return out.stdout.trim();
  }

  async function makeEmptyGitRepo(cn: ComputeNode): Promise<string> {
    const dir = await shell(cn, 'mktemp -d');
    await shell(cn, `git -C ${dir} init`);
    await shell(cn, `git -C ${dir} config user.email test@test.com`);
    await shell(cn, `git -C ${dir} config user.name Test`);
    return dir;
  }

  async function makeGitRepo(cn: ComputeNode): Promise<string> {
    const dir = await shell(cn, 'mktemp -d');
    await shell(cn, `git -C ${dir} init`);
    await shell(cn, `git -C ${dir} config user.email test@test.com`);
    await shell(cn, `git -C ${dir} config user.name Test`);
    await shell(cn, `echo hello > ${dir}/readme.txt`);
    await shell(cn, `git -C ${dir} add .`);
    await shell(cn, `git -C ${dir} commit -m init`);
    return dir;
  }

  async function cleanupDir(cn: ComputeNode, dir: string): Promise<void> {
    await shell(cn, `rm -rf ${dir}`);
  }

  // -------------------------------------------------------------------------
  // isInit — non-git path
  // -------------------------------------------------------------------------

  it('isInit returns false for /tmp (non-git dir)', async () => {
    const result = await new GitRepo('/tmp').isInit();
    expect(result).toBe(false);
  }, 10000);

  // -------------------------------------------------------------------------
  // getBranch — non-git path
  // -------------------------------------------------------------------------

  it('getBranch returns null for /tmp', async () => {
    const result = await new GitRepo('/tmp').getBranch();
    expect(result).toBeNull();
  }, 10000);

  it('getBranch returns a branch string for a real git repo', async () => {
    const cn = getComputeNode();
    const dir = await makeGitRepo(cn);
    try {
      const result = await new GitRepo(dir, cn.id).getBranch();
      expect(typeof result).toBe('string');
      expect(result!.length).toBeGreaterThan(0);
    } finally {
      await cleanupDir(cn, dir);
    }
  }, 20000);

  // -------------------------------------------------------------------------
  // isLinkedWorktree — non-git path
  // -------------------------------------------------------------------------

  it('isLinkedWorktree returns false for /tmp', async () => {
    const result = await new GitRepo('/tmp').isLinkedWorktree();
    expect(result).toBe(false);
  }, 10000);

  it('isLinkedWorktree returns true for a linked worktree', async () => {
    const cn = getComputeNode();
    const mainDir = await makeGitRepo(cn);
    const worktreeDir = await shell(cn, 'mktemp -d --dry-run');
    try {
      await shell(cn, `git -C ${mainDir} worktree add ${worktreeDir}`);
      const result = await new GitRepo(worktreeDir, cn.id).isLinkedWorktree();
      expect(result).toBe(true);
    } finally {
      await cleanupDir(cn, mainDir);
      await cleanupDir(cn, worktreeDir);
    }
  }, 20000);

  // -------------------------------------------------------------------------
  // getStatus — non-git path
  // -------------------------------------------------------------------------

  it('getStatus returns error field for /tmp (not a git repo)', async () => {
    const status = await new GitRepo('/tmp').getStatus();
    expect(status.error).toBe('not a git repository');
    expect(status.branch).toBeNull();
    expect(status.files).toEqual([]);
  }, 10000);

  // -------------------------------------------------------------------------
  // isInit — workspace path (expected to be on the filesystem)
  // -------------------------------------------------------------------------

  it('isInit returns a boolean for the workspace path', async () => {
    const root = dataContext.bootstrapInfo?.desktop_info?.paths?.root ?? '/';
    const workspace = dataContext.bootstrapInfo?.desktop_info?.paths?.workspace;
    if (!workspace) return; // skip if bootstrap does not expose paths
    const absPath = root + workspace;
    const result = await new GitRepo(absPath).isInit();
    expect(typeof result).toBe('boolean');
  }, 10000);

  // -------------------------------------------------------------------------
  // hasCommit
  // -------------------------------------------------------------------------

  it('hasCommit returns false for /tmp (non-git dir)', async () => {
    const result = await new GitRepo('/tmp').hasCommit();
    expect(result).toBe(false);
  }, 10000);

  it('hasCommit returns true for a repo with commits', async () => {
    const cn = getComputeNode();
    const dir = await makeGitRepo(cn);
    try {
      const result = await new GitRepo(dir, cn.id).hasCommit();
      expect(result).toBe(true);
    } finally {
      await cleanupDir(cn, dir);
    }
  }, 20000);

  it('hasCommit returns false for an empty repo (no commits)', async () => {
    const cn = getComputeNode();
    const dir = await makeEmptyGitRepo(cn);
    try {
      const result = await new GitRepo(dir, cn.id).hasCommit();
      expect(result).toBe(false);
    } finally {
      await cleanupDir(cn, dir);
    }
  }, 20000);

  // -------------------------------------------------------------------------
  // ComputeNode.git() helper
  // -------------------------------------------------------------------------

  it('ComputeNode.git() creates a GitRepo bound to the compute node', async () => {
    const cn = getComputeNode();
    const git = cn.git('/tmp');
    expect(git).toBeInstanceOf(GitRepo);
    expect(git.workDir).toBe('/tmp');
    expect(git.computeNodeId).toBe(cn.id);
  }, 10000);
});
