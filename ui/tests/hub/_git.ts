/**
 * Git fixtures for hub tests.
 *
 * Sharing a Project or a Folder routes through the git publish preflight
 * (`assert_project_publishable` → `git_share_preflight`), which demands the
 * folder be in a repo, with a real `origin`, clean, and fully pushed. That is a
 * BACKEND PRECONDITION, not the subject of any one test — so it lives here once
 * instead of being re-derived in every test that happens to share something.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';

/** Run a git command in `cwd`; throws with git's output on failure. */
export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * A bare `file://` remote plus a worktree cloned from it — the only state the
 * publish preflight accepts. The worktree is on `main`, has a committer
 * identity, and tracks `origin/main`; it is EMPTY, so the caller seeds whatever
 * files it needs and then calls `commitAndPush`.
 *
 * Paths are realpath'd: on macOS a tmpdir is a symlink (`/tmp` → `/private/tmp`)
 * and the backend canonicalizes, so an un-resolved path never matches.
 * The caller owns `root`'s lifetime (push it onto its own temp-root list).
 */
export function makeGitWorktree(prefix: string): { root: string; remote: string; worktree: string } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const remote = path.join(root, 'remote.git');
  const worktree = path.join(root, 'worktree');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'clone', '-q', pathToFileURL(remote).href, worktree);
  // Load-bearing: a clone of an empty repo adopts the local `init.defaultBranch`,
  // which is `master` on plenty of machines — and then `push origin main` fails.
  git(worktree, 'checkout', '-q', '-b', 'main');
  git(worktree, 'config', 'user.email', 'alice@example.test');
  git(worktree, 'config', 'user.name', 'Alice');
  return { root, remote, worktree };
}

/** Satisfy the "clean and pushed" half of the preflight for everything in `dir`. */
export function commitAndPush(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
}
