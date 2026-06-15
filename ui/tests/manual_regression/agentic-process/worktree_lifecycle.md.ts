/**
 * Worktree lifecycle — OpenInWorktree gating + spawn; CommitMerge presence.
 * Source: worktree_lifecycle.md
 *
 * OpenInWorktreeButton (aria-label="Open in Worktree") is enabled only when the
 * process workdir is a git repo with ≥1 commit (computeNode.git(workdir).hasCommit()).
 * Clicking it spawns a worktree sibling (AgenticProcess.spawn({worktree:true})),
 * whose Info "Worktree" row reads "enabled" and Command contains --worktree, and
 * which renders the CommitMergeButton (gated on cliOptions.worktree).
 *
 * The default project workdir is /Users/shlom/Flowpad workspace/my_first_project.
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
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, activePanel, sessionPopover } from './_ap_helpers';

const PROJECT_DIR = '/Users/shlom/Flowpad workspace/my_first_project';

function gitInitWithCommit(dir: string) {
  execSync('git init -q && git -c user.email=qa@local -c user.name=qa commit -q --allow-empty -m init', { cwd: dir });
}
function gitInitNoCommit(dir: string) {
  execSync('git init -q', { cwd: dir });
}
function cleanGit(dir: string) {
  if (existsSync(`${dir}/.git`)) rmSync(`${dir}/.git`, { recursive: true, force: true });
}

const worktreeBtn = (page: import('@playwright/test').Page) =>
  activePanel(page).locator('button[aria-label="Open in Worktree"]');

test.describe('worktree lifecycle', () => {
  test.afterEach(() => { cleanGit(PROJECT_DIR); });

  test('test 1: OpenInWorktree spawns a worktree sibling; CommitMerge appears in it', async ({ page }) => {
    test.setTimeout(60_000);
    cleanGit(PROJECT_DIR);
    gitInitWithCommit(PROJECT_DIR);

    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Parent (non-worktree): OpenInWorktree enabled, no CommitMerge button.
    await expect(worktreeBtn(page)).toBeEnabled({ timeout: 15_000 });
    expect(await activePanel(page).locator('button[aria-label="Commit & Merge"]').count()).toBe(0);

    await worktreeBtn(page).click();

    // New worktree process: the URL was already agentic_process-<pid>, so wait
    // for the id to *change* (a sibling spawned), not just match the pattern.
    await expect(async () => {
      expect(page.url()).toMatch(/agentic_process-[\w-]+/);
      expect(processIdFromUrl(page)).not.toBe(pid);
    }).toPass({ timeout: 30_000 });
    const wtPid = processIdFromUrl(page);
    expect(wtPid).not.toBe(pid);
    await waitForRunningSession(page, apiBase(), wtPid);

    // Info popover: Worktree row "enabled" + Command contains --worktree.
    await activePanel(page).locator('button[aria-label$="session info"]').click();
    const pop = sessionPopover(page);
    await expect(pop).toBeVisible({ timeout: 10_000 });
    const worktreeRow = pop.getByText(/^Worktree$/).locator('xpath=..');
    await expect(worktreeRow.getByText('enabled')).toBeVisible();
    // CopyRow redesign: value lives in the flex-1 mono span (copy is a
    // separate aria-labelled icon button), not a "Click to copy" button.
    const cmdRow = pop.getByText(/^Command$/).locator('xpath=..').locator('span.flex-1');
    await expect(cmdRow).toContainText('--worktree');
    await page.keyboard.press('Escape');

    // CommitMergeButton IS rendered inside the worktree tab.
    await expect(activePanel(page).locator('button[aria-label="Commit & Merge"]')).toBeVisible({ timeout: 10_000 });
  });

  test('test 2: OpenInWorktree disabled when the workdir has no commits', async ({ page }) => {
    test.setTimeout(60_000);
    cleanGit(PROJECT_DIR);
    gitInitNoCommit(PROJECT_DIR);

    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // hasCommit() is false → button disabled.
    await expect(worktreeBtn(page)).toBeDisabled({ timeout: 15_000 });
    await worktreeBtn(page).hover({ force: true });
    await expect(page.getByText('Requires a git repository with at least one commit')).toBeVisible({ timeout: 5_000 });
  });
});
