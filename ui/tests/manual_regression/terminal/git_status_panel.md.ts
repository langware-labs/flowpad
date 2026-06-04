/**
 * Regression tests: Git Status Side Panel (Unified Side Window)
 *
 * Feature: A GitBranch icon in the TerminalBottomRibbon (agentic process terminals only)
 * opens a Git tab in the unified side window showing the current branch, ahead/behind counts,
 * and a list of changed/added/deleted/untracked files with per-file insertion/deletion counts.
 *
 * Key files:
 *   ui/src/components/terminal/interactive-terminal/side-windows/GitPanel.tsx
 *   ui/src/components/terminal/interactive-terminal/side-windows/SideWindow.tsx
 *   ui/src/components/terminal/interactive-terminal/TerminalBottomRibbon.tsx
 *   ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx
 *   flow_sdk/builtin/faas/compute_node.py  (git-status action)
 *
 * Implementation notes:
 *   - Side window container: .w-80.flex-col.border-l (SideWindow)
 *   - Tab strip: first .border-b inside the side window
 *   - Git tab × close button: button[aria-label="Close Git"]
 *   - Git panel header has exactly 1 button (Refresh); NO X in the panel header
 *   - File rows: .overflow-y-auto .flex.items-center.gap-2.rounded (hover:bg-muted/50)
 *   - Ribbon .ml-auto button order: 0=Context, 1=Git, 2=Prompts, 3=Files, 4=Dir
 *   - The ribbon only renders when an AgenticProcess is linked to the shell (process prop truthy)
 *   - Panel polls the git-status action every 5 seconds while open
 *
 * Tests 1–6, 8, 10 are fully automatable.
 * Test 7 (non-git workdir) requires env with a process pointing to a non-git dir.
 * Test 9 (auto-refresh) is automatable but requires filesystem write access.
 */
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { dismissSetupModal, startClaudeSession } from './helpers';

const APP_URL = process.env.APP_URL ?? 'http://localhost:4098';
const API_URL = process.env.API_URL ?? 'http://localhost:9008';
// repo root of this checkout (ui/tests/manual_regression/terminal → 4 levels up)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Cache the agentic process URL after the first successful navigation.
 * Reusing it avoids repeated new_terminal round-trips (each of which creates
 * a new shell entity and can land on a freshly-starting Claude instance that
 * takes >60s before the ribbon appears).
 */
let cachedAgenticUrl: string | null = null;

/**
 * Navigate to an agentic process terminal.
 * Creates one via "Start Claude" if needed.
 */
async function gotoAgenticProcess(page: import('@playwright/test').Page) {
  const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
  const ribbon = activePanel.locator('.border-t .ml-auto');

  // Fast path: reuse the URL from the first successful navigation in this run.
  if (cachedAgenticUrl) {
    await page.goto(cachedAgenticUrl);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 15_000 });
    const visible = await ribbon.isVisible({ timeout: 10_000 }).catch(() => false);
    if (visible) return;
    // Cached process is gone — fall through to full navigation.
  }

  await page.goto('/dock/shell/new_terminal');

  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

  if (!page.url().includes('agentic_process-')) {
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 60_000 });
    await startClaudeSession(page);
    await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 60_000 });
  }

  // Wait for the ribbon to be visible (can take >8s on a fresh process).
  await expect(ribbon).toBeVisible({ timeout: 60_000 });

  // Cache URL for subsequent tests in this run.
  cachedAgenticUrl = page.url();
}

/**
 * Get the side window container (w-80 flex-col border-l).
 */
function getSideWindow(page: import('@playwright/test').Page) {
  return page.locator('.w-80.flex-col.border-l');
}

/**
 * Get the compute_node entity ID from the API.
 */
async function getComputeNodeId(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/graph/compute_node`);
    const json = await res.json() as { data?: Array<{ id?: string }> };
    return json.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

test.describe('Git Status Panel', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ---------------------------------------------------------------------------
  // test 1: Git button appears in agentic process terminal ribbon
  // ---------------------------------------------------------------------------
  test('git status button appears in agentic process terminal ribbon', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcess(page);

    // Ribbon should be visible — check the ml-auto button container
    // (text=/running|idle/i is unreliable: may match a visibility:hidden tooltip element)
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');
    await expect(mlAuto).toBeVisible({ timeout: 15_000 });

    // Right section has 5 buttons: Context(0), Git(1), Prompts(2), Files(3), Dir(4)
    await expect(mlAuto.locator("button").nth(1)).toBeVisible({ timeout: 5_000 });

    // Validate all 5 buttons are present
    await expect(mlAuto.locator('button')).toHaveCount(5, { timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // test 2: Git panel opens as a tab in the side window
  // ---------------------------------------------------------------------------
  test('git panel opens as a tab in the side window when git button is clicked', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');
    const gitBtn = mlAuto.locator("button").nth(1);
    await gitBtn.click();

    // Side window should appear (w-80 flex-col border-l)
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Tab strip should show a "Git" tab
    const tabStrip = sideWindow.locator('.border-b').first();
    await expect(tabStrip.getByText('Git')).toBeVisible({ timeout: 5_000 });

    // Tab has a × close button
    await expect(page.locator('button[aria-label="Close Git"]')).toBeVisible({ timeout: 5_000 });

    // Git panel inner header should be visible
    const panelHeader = sideWindow.locator('.flex-1 .border-b');
    await expect(panelHeader).toBeVisible({ timeout: 5_000 });

    // Inner header should have exactly 1 button (Refresh — no X in panel header)
    const headerButtons = panelHeader.locator('button');
    await expect(headerButtons).toHaveCount(1);
  });

  // ---------------------------------------------------------------------------
  // test 3: Git panel header shows branch name and ahead/behind indicators
  // ---------------------------------------------------------------------------
  test('git panel header shows branch name', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await activePanel.locator('.border-t .ml-auto button').nth(1).click();

    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Wait for data to load (loading skeleton disappears)
    await page.waitForTimeout(3_000);

    const panelHeader = sideWindow.locator('.flex-1 .border-b');
    const headerText = await panelHeader.textContent();

    // Should show either a branch name or "Not a git repo"
    expect(headerText).toBeTruthy();
    expect(headerText!.length).toBeGreaterThan(0);

    const isGitRepo = !headerText!.includes('Not a git repo');
    if (isGitRepo) {
      const branchName = headerText!.replace(/[↑↓\d]/g, '').trim();
      expect(branchName.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // test 4: Git panel shows changed files with status badges and line counts
  // ---------------------------------------------------------------------------
  test('git panel shows file list with status badges and line counts', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await activePanel.locator('.border-t .ml-auto button').nth(1).click();

    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(5_000);

    const body = sideWindow.locator('.flex-1 .overflow-y-auto');
    const bodyText = await body.textContent();

    if (bodyText?.includes('No changes')) {
      test.skip(true, 'No changed files in git workdir — cannot validate file rows');
      return;
    }

    if (bodyText?.includes('Not a git repository') || bodyText?.includes('Not a git repo')) {
      test.skip(true, 'Process workdir is not a git repository in this environment');
      return;
    }

    // Validate file rows exist
    const rows = body.locator('.flex.items-center.gap-2.rounded');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Validate first row: status badge should be a short code (M, A, D, ?, R)
    const firstRow = rows.first();
    await expect(firstRow).toBeVisible();
    const statusBadge = firstRow.locator('span').first();
    const statusText = await statusBadge.textContent();
    expect(['M', 'A', 'D', '?', 'R', 'U']).toContain(statusText?.trim());
  });

  // ---------------------------------------------------------------------------
  // test 5: Git tab closes via × in the tab strip
  // ---------------------------------------------------------------------------
  test('git tab closes via the × close button in the tab strip', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await activePanel.locator('.border-t .ml-auto button').nth(1).click();

    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Click the × in the Git tab (aria-label set in SideWindow.tsx)
    await page.locator('button[aria-label="Close Git"]').click();

    // Side window should disappear (no tabs left)
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // test 6: Multiple tabs coexist in the same side window
  // ---------------------------------------------------------------------------
  test('git and prompts tabs coexist and can be switched between', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');

    // Open Git (index 1)
    await mlAuto.locator("button").nth(1).click();
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });
    // Use tab strip + exact match to avoid strict-mode violation (other elements contain 'Git')
    const tabStripA = sideWindow.locator('.border-b').first();
    await expect(tabStripA.getByText('Git', { exact: true })).toBeVisible({ timeout: 3_000 });

    // Open Prompts (index 2) — adds a second tab
    await mlAuto.locator("button").nth(2).click();
    await expect(tabStripA.getByText('Prompts', { exact: true })).toBeVisible({ timeout: 3_000 });

    // Both tabs should be visible in the tab strip (reuse tabStripA)
    await expect(tabStripA.getByText('Git', { exact: true })).toBeVisible();
    await expect(tabStripA.getByText('Prompts', { exact: true })).toBeVisible();

    // Click the Git tab label → Git panel becomes active
    await tabStripA.getByText('Git', { exact: true }).click();
    const panelHeader = sideWindow.locator('.flex-1 .border-b');
    // Git panel header has a Refresh button (not a Prompts header)
    await expect(panelHeader.locator('button')).toHaveCount(1, { timeout: 3_000 });

    // Close Prompts tab — Git should remain
    await page.locator('button[aria-label="Close Prompts"]').click();
    await expect(tabStripA.getByText('Prompts', { exact: true })).not.toBeVisible({ timeout: 3_000 });
    await expect(tabStripA.getByText('Git', { exact: true })).toBeVisible();

    // Close Git tab — side window should disappear
    await page.locator('button[aria-label="Close Git"]').click();
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // test 8: Git button is absent for plain shell terminals (no agentic process)
  // ---------------------------------------------------------------------------
  test('git button is absent in plain shell terminal (no agentic process)', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/dock/shell/new_terminal');
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

    await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

    if (page.url().includes('agentic_process-')) {
      test.skip(true, 'App redirected to existing agentic process; plain shell not available in this environment');
      return;
    }

    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(2_000);

    // On plain shell: ribbon (.border-t .ml-auto) is NOT present
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');
    await expect(mlAuto).not.toBeVisible({ timeout: 3_000 });
  });

  // ---------------------------------------------------------------------------
  // test 10: git-status API endpoint returns correct structure
  // ---------------------------------------------------------------------------
  test('git-status API returns correct shape for git and non-git dirs', async () => {
    test.setTimeout(30_000);

    const nodeId = await getComputeNodeId();
    if (!nodeId) {
      test.skip(true, 'Could not find compute_node entity ID');
      return;
    }

    // --- git repo case ---
    const gitRes = await fetch(
      `${API_URL}/api/v1/graph/compute_node/${nodeId}/git-ops/status?workdir=${encodeURIComponent(REPO_ROOT)}`
    );
    expect(gitRes.status).toBe(200);
    const gitJson = await gitRes.json() as {
      status: string;
      data?: {
        branch?: string | null;
        ahead?: number;
        behind?: number;
        files?: Array<{ status: string; path: string; insertions: number | null; deletions: number | null }>;
        error?: string | null;
      };
    };
    expect(gitJson.status).toBe('SUCCESS');
    const gitData = gitJson.data!;
    expect(gitData.error).toBeNull();
    expect(typeof gitData.branch).toBe('string');
    expect(typeof gitData.ahead).toBe('number');
    expect(typeof gitData.behind).toBe('number');
    expect(Array.isArray(gitData.files)).toBe(true);

    for (const f of gitData.files ?? []) {
      expect(typeof f.status).toBe('string');
      expect(typeof f.path).toBe('string');
      expect(f.status.length).toBeGreaterThan(0);
      expect(f.path.length).toBeGreaterThan(0);
      expect(f.insertions === null || typeof f.insertions === 'number').toBe(true);
      expect(f.deletions === null || typeof f.deletions === 'number').toBe(true);
    }

    // --- non-git dir case ---
    const nonGitRes = await fetch(
      `${API_URL}/api/v1/graph/compute_node/${nodeId}/git-ops/status?workdir=/tmp`
    );
    expect(nonGitRes.status).toBe(200);
    const nonGitJson = await nonGitRes.json() as {
      status: string;
      data?: { error?: string | null; files?: unknown[] };
    };
    expect(nonGitJson.status).toBe('SUCCESS');
    const nonGitData = nonGitJson.data!;
    expect(nonGitData.error).toBeTruthy();
    expect(Array.isArray(nonGitData.files)).toBe(true);
    expect(nonGitData.files?.length).toBe(0);
  });
});
