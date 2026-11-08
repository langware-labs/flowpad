/**
 * Worktree lifecycle — OpenInWorktree gating + spawn; CommitMerge presence.
 * Source: worktree_lifecycle.md
 *
 * "Open in Worktree" (session actions menu, session-action-worktree) is enabled only when the
 * process workdir is a git repo with ≥1 commit (computeNode.git(workdir).hasCommit()).
 * Clicking it spawns a worktree sibling (AgenticProcess.spawn({worktree:true})),
 * whose Info "Worktree" row reads "enabled" and Command contains --worktree, and
 * which offers "Commit & Merge" in the session actions menu (gated on cliOptions.worktree).
 *
 * The default project workdir is /Users/alice/Flowpad workspace/my_first_project.
 * A new_terminal shell adopts that workdir (the loader ignores any ?cwd= param),
 * so to exercise both the enabled and disabled gates we control that dir's git
 * state in the test fixture and restore it afterwards (it is otherwise empty).
 *
 * test 3 (CommitMerge actually commits+merges) requires Claude to run a full
 * git turn (commit → merge → exit worktree), an open-ended multi-minute live
 * response — see the result JSON skip note. test 1/2 are automated here.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { apiContext } from '../_shared/api';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, sessionPopover, sessionAction, AP_HAS_CLAUDE_ONLY_CLI_FLAGS, AP_OPENER, restoreStandardMode, selectAdvancedMode } from './_ap_helpers';
import { adjusted } from '../../adjustableTimeout';

// The instance's OWN project folder, asked of the backend — a named instance's
// workspace is `~/Flowpad workspaces/<name>/`, so a hardcoded prod path both
// misses the folder the shell opens in and writes into prod's workspace.
let PROJECT_DIR = '';
async function resolveProjectDir(): Promise<string> {
  const api = await apiContext();
  const rows = ((await (await api.get('/api/v1/graph/project')).json()).data ?? []) as { id: string; name: string }[];
  const id = rows.find((r) => r.name === 'my_first_project')?.id;
  const dir = id
    ? ((await (await api.get(`/api/v1/graph/project/${id}`)).json()).data?.fs_storage_mount_path as string | undefined)
    : undefined;
  await api.dispose();
  if (!dir) throw new Error("could not resolve this instance's my_first_project folder");
  return dir;
}

function gitInitWithCommit(dir: string) {
  execSync('git init -q && git -c user.email=qa@local -c user.name=qa commit -q --allow-empty -m init', { cwd: dir });
}
function gitInitNoCommit(dir: string) {
  execSync('git init -q', { cwd: dir });
}
function cleanGit(dir: string) {
  if (existsSync(`${dir}/.git`)) rmSync(`${dir}/.git`, { recursive: true, force: true });
}

// "Open in Worktree" / "Commit & Merge" are items of the session actions menu.
// The repo check runs once the menu is open, so the item is read with it open.
const worktreeItem = (page: import('@playwright/test').Page) => sessionAction(page, 'session-action-worktree');
const commitMergeItem = (page: import('@playwright/test').Page) => sessionAction(page, 'session-action-commit-merge');

test.describe('worktree lifecycle', () => {
  // The worktree sibling opens without a stated mode, so on the instance's last SELECTED mode: on
  // Standard the UI switch-modes it to a headless chat, which SIGTERMs the new PTY within seconds (exit
  // 143) and the sibling reads `stopped`. This lifecycle is the PTY branch: select Advanced, restore after.
  let switchedMode = false;
  test.afterAll(async ({ browser }, info) => {
    if (switchedMode) await restoreStandardMode(browser, info.project.use.baseURL);
  });
  test.beforeAll(async () => { PROJECT_DIR = await resolveProjectDir(); });
  test.afterEach(() => { if (PROJECT_DIR) cleanGit(PROJECT_DIR); });

  /**
   * A fresh folder is not trusted by Claude yet, and Claude refuses --worktree there; the plain session shows its
   * own "Is this a project you created or one you trust?" prompt (No, exit selected). Answer it as a person
   * does — Yes, I trust this folder — so Open in Worktree can then start a real worktree session.
   */
  async function acceptFolderTrust(page: import('@playwright/test').Page) {
    const rows = page.locator('.xterm-rows:visible').first();
    await expect(rows).toContainText(/I trust this folder|❯/, { timeout: 15_000 });
    if (!(await rows.textContent())?.includes('I trust this folder')) return;
    await rows.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(rows).not.toContainText('I trust this folder', { timeout: 15_000 });
  }

  test('test 1: OpenInWorktree spawns a worktree sibling; CommitMerge appears in it', async ({ page }) => {
    // --worktree is claude-only (getWorkerCliCapabilities reports worktree:false
    // for codex/copilot/opencode), so the Open-in-Worktree affordance correctly
    // does not render on those arms.
    test.skip(!AP_HAS_CLAUDE_ONLY_CLI_FLAGS, `${AP_OPENER} has no --worktree flag`);
    test.setTimeout(adjusted(60_000));
    cleanGit(PROJECT_DIR);
    gitInitWithCommit(PROJECT_DIR);

    await dismissSetupModal(page);
    await gotoNewShell(page);
    await selectAdvancedMode(page);
    switchedMode = true;
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);
    await acceptFolderTrust(page);

    // Parent (non-worktree): OpenInWorktree enabled, no CommitMerge button.
    await expect(await worktreeItem(page)).not.toHaveAttribute('data-disabled', /.*/, { timeout: adjusted(15_000) });
    expect(await (await commitMergeItem(page)).count()).toBe(0);

    await (await worktreeItem(page)).click();

    // New worktree process: the URL was already agentic_process-<pid>, so wait
    // for the id to *change* (a sibling spawned), not just match the pattern.
    await expect(async () => {
      expect(page.url()).toMatch(/agentic_process-[\w-]+/);
      expect(processIdFromUrl(page)).not.toBe(pid);
    }).toPass({ timeout: adjusted(30_000) });
    const wtPid = processIdFromUrl(page);
    expect(wtPid).not.toBe(pid);
    await waitForRunningSession(page, apiBase(), wtPid);

    // Info popover: Worktree row "enabled" + Command contains --worktree.
    await (await sessionAction(page, 'session-action-info')).click();
    const pop = sessionPopover(page);
    await expect(pop).toBeVisible({ timeout: adjusted(10_000) });
    const worktreeRow = pop.getByText(/^Worktree$/).locator('xpath=..');
    await expect(worktreeRow.getByText('enabled')).toBeVisible();
    // CopyRow redesign: value lives in the flex-1 mono span (copy is a
    // separate aria-labelled icon button), not a "Click to copy" button.
    const cmdRow = pop.getByText(/^Command$/).locator('xpath=..').locator('span.flex-1');
    await expect(cmdRow).toContainText('--worktree');
    await page.keyboard.press('Escape');

    // Commit & Merge IS offered inside the worktree tab.
    await expect(await commitMergeItem(page)).toBeVisible({ timeout: adjusted(10_000) });
  });

  test('test 2: OpenInWorktree disabled when the workdir has no commits', async ({ page }) => {
    test.setTimeout(adjusted(60_000));
    cleanGit(PROJECT_DIR);
    gitInitNoCommit(PROJECT_DIR);

    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // hasCommit() is false → item disabled, with the reason printed on it.
    const item = await worktreeItem(page);
    await expect(item).toHaveAttribute('data-disabled', /.*/, { timeout: adjusted(15_000) });
    await expect(item.getByText('Requires a git repository with at least one commit')).toBeVisible({ timeout: adjusted(5_000) });
  });
});
