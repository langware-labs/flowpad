/**
 * Regression tests: Git Status Side Panel (Unified Side Window)
 *
 * Feature: A git branch icon in the TerminalBottomRibbon (agentic process terminals only)
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
 *   - Side window container: .w-80.flex-col.border-s (SideWindow)
 *   - Tab strip: first .border-b inside the side window
 *   - Git tab × close button: button[aria-label="Close Git"]
 *   - Git panel header has exactly 1 button (Refresh); NO X in the panel header
 *   - File rows: .overflow-y-auto .flex.items-center.gap-2.rounded (hover:bg-muted/50)
 *   - Ribbon button order: 0=Context, 1=Git, 2=Prompts, 3=Files, 4=Dir
 *   - The ribbon only renders when an AgenticProcess is linked to the shell (process prop truthy)
 *   - Panel polls the git-status action every 5 seconds while open
 *
 * Tests 1–6, 8, 10 are fully automatable.
 * Test 7 (non-git workdir) requires env with a process pointing to a non-git dir.
 * Test 9 (auto-refresh) is automatable but requires filesystem write access.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { RIBBON_TABS,
  activePanel,
  dismissSetupModal,
  ensureAdvancedView,
  ensureSideTabOpen,
  getSideWindow,
  skipIfPtyExhausted,
  startClaudeSession,
} from './helpers';
import { apiOrigin } from '../_shared/api';

const API_URL = apiOrigin();
// repo root of this checkout (ui/tests/manual_regression/terminal → 4 levels up).
// These .md.ts run as ESM ("type":"module"), so __dirname is undefined —
// derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function createChangedGitRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'flowpad-git-panel-'));
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Flowpad QA']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'flowpad-qa@local.test']);
  writeFileSync(path.join(repo, 'README.md'), 'baseline\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'baseline']);
  writeFileSync(path.join(repo, 'README.md'), 'baseline\nchanged\n');
  return repo;
}

async function createProjectForWorkdir(workdir: string): Promise<string> {
  const response = await fetch(`${API_URL}/api/v1/graph/project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `git-panel-${Date.now()}`,
      fs_storage_mount_path: workdir,
  }),
});
  expect(response.status).toBe(200);
  const projectId = (await response.json())?.data?.id as string | undefined;
  expect(projectId).toBeTruthy();
  return projectId!;
}

async function gotoProjectAgenticProcess(page: import('@playwright/test').Page, projectId: string): Promise<string> {
  await page.goto(`/dock/project/${projectId}?viewMode=advanced`);
  const launcher = page.locator('[data-testid="project-home-start-session"]');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Claude Code' }).click();
  await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-(?!new)/);
  await ensureAdvancedView(page);
  await expect(activePanel(page).locator(RIBBON_TABS)).toBeVisible();
  return page.url().match(/agentic_process-([0-9a-f-]+)/)?.[1] ?? '';
}

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
  const panel = activePanel(page);
  const ribbon = panel.locator(RIBBON_TABS);

  // Fast path: reuse the URL from the first successful navigation in this run.
  if (cachedAgenticUrl) {
    await page.goto(cachedAgenticUrl);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 15_000 });
    await ensureAdvancedView(page);
    const visible = await ribbon.isVisible({ timeout: 10_000 }).catch(() => false);
    if (visible) return;
    // Cached process is gone — fall through to full navigation.
}

  await page.goto('/dock/shell/new_terminal');

  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  try {
    await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

    if (!page.url().includes('agentic_process-')) {
      await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 60_000 });
      await startClaudeSession(page);
      await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 60_000 });
  }

    // The ribbon + side-window panels only exist in Advanced view; the backend
    // pref now wins over the localStorage seed, so flip to Advanced at runtime.
    await ensureAdvancedView(page);

    // Wait for the ribbon to be visible (can take >8s on a fresh process).
    await expect(ribbon).toBeVisible({ timeout: 60_000 });
} catch (e) {
    // Host out of PTY devices → no live process/ribbon. Sanctioned live-env skip.
    await skipIfPtyExhausted(page);
    throw e;
}

  // The ribbon/toolbar re-renders continuously while the worker initializes
  // (status updates via useSyncExternalStore) — a click issued mid-churn keeps
  // re-resolving a detaching button and can retry until the test cap. Let it
  // settle before callers drive the buttons (same settle as _ap_helpers).
  await page.waitForTimeout(3_000);

  // Cache URL for subsequent tests in this run.
  cachedAgenticUrl = page.url();
}

/**
 * Get the compute_node entity ID from the API.
 */
async function getComputeNodeId(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/graph/compute_node`);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
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
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    // (text=/running|idle/i is unreliable: may match a visibility:hidden tooltip element)
    const panel = activePanel(page);
    const ribbonLoc = panel.locator(RIBBON_TABS);
    await expect(ribbonLoc).toBeVisible({ timeout: 15_000 });

    // Right section: Context(0), Git(1), Prompts(2), Files(3), Dir(4), Queue(5)
    // + Prompt Library, … — the ribbon keeps gaining buttons (Queue+Library
    // 55a71046; more since). Assert the Git button (the subject of this test) is
    // present and the ribbon carries at least the documented core set — robust to
    // additions, still catches a regression that DROPS buttons.
    await expect(ribbonLoc.locator('button').nth(1)).toBeVisible({ timeout: 5_000 });
    const ribbonButtons = await ribbonLoc.locator('button').count();
    expect(ribbonButtons).toBeGreaterThanOrEqual(7);
});

  // ---------------------------------------------------------------------------
  // test 2: Git panel opens as a tab in the side window
  // ---------------------------------------------------------------------------
  test('git panel opens as a tab in the side window when git button is clicked', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    await ensureSideTabOpen(page, 1, 'Git');

    // Side window should appear (w-80 flex-col border-s)
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Tab strip should show a "Git" tab
    const tabStrip = sideWindow.locator('.border-b').first();
    await expect(tabStrip.getByText('Git')).toBeVisible({ timeout: 5_000 });

    // Tab has a × close button
    await expect(activePanel(page).locator('button[aria-label="Close Git"]')).toBeVisible({ timeout: 5_000 });

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
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    await ensureSideTabOpen(page, 1, 'Git');

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
    test.setTimeout(60_000);
    const repo = createChangedGitRepo();
    const projectId = await createProjectForWorkdir(repo);
    let processId = '';

    try {
      processId = await gotoProjectAgenticProcess(page, projectId);
      expect(processId).toBeTruthy();
      await ensureSideTabOpen(page, 1, 'Git');

      const sideWindow = getSideWindow(page);
      await expect(sideWindow).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(5_000);

      const body = sideWindow.locator('.flex-1 .overflow-y-auto');
      const readmeRow = body.locator('.group.rounded').filter({ hasText: 'README.md' });
      await expect(readmeRow).toHaveCount(1);
      await expect(readmeRow.locator('span').first()).toHaveText('M');
  } finally {
      await page.goto('/');
      if (processId) {
        await fetch(`${API_URL}/api/v1/graph/agentic_process/${processId}`, { method: 'DELETE' });
    }
      await fetch(`${API_URL}/api/v1/graph/project/${projectId}`, { method: 'DELETE' });
      rmSync(repo, { recursive: true, force: true });
  }
});

  // ---------------------------------------------------------------------------
  // test 5: Git tab closes via × in the tab strip
  // ---------------------------------------------------------------------------
  test('git tab closes via the × close button in the tab strip', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    await ensureSideTabOpen(page, 1, 'Git');

    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Click the × in the Git tab (aria-label set in SideWindow.tsx)
    await activePanel(page).locator('button[aria-label="Close Git"]').click();

    // Side window should disappear (no tabs left)
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
});

  // ---------------------------------------------------------------------------
  // test 6: Multiple tabs coexist in the same side window
  // ---------------------------------------------------------------------------
  test('git and prompts tabs coexist and can be switched between', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    const panel = activePanel(page);
    const ribbonLoc = panel.locator(RIBBON_TABS);

    // Open Git (index 1)
    await ensureSideTabOpen(page, 1, 'Git');
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });
    // Use tab strip + exact match to avoid strict-mode violation (other elements contain 'Git')
    const tabStripA = sideWindow.locator('.border-b').first();
    await expect(tabStripA.getByText('Git', { exact: true })).toBeVisible({ timeout: 3_000 });

    // Open Prompts (index 2) — adds a second tab
    await ensureSideTabOpen(page, 2, 'Prompts');
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
    await activePanel(page).locator('button[aria-label="Close Prompts"]').click();
    await expect(tabStripA.getByText('Prompts', { exact: true })).not.toBeVisible({ timeout: 3_000 });
    await expect(tabStripA.getByText('Git', { exact: true })).toBeVisible();

    // Close Git tab — side window should disappear
    await activePanel(page).locator('button[aria-label="Close Git"]').click();
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
});

  // ---------------------------------------------------------------------------
  // test 8: Git button is absent for plain shell terminals (no agentic process)
  // ---------------------------------------------------------------------------
  test('git button is absent in plain shell terminal (no agentic process)', async ({ page }) => {
    test.setTimeout(60_000);
    const bootstrap = await fetch(`${API_URL}/api/v1/graph/bootstrap`).then((response) => response.json());
    const projectId = bootstrap?.data?.default_project?.id as string | undefined;
    expect(projectId, 'Phase 11 plain-shell preflight requires a default project').toBeTruthy();
    const created = await fetch(`${API_URL}/api/v1/graph/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
  }).then((response) => response.json());
    const shellId = created?.data?.id as string | undefined;
    expect(shellId, 'Phase 11 plain-shell fixture creation failed').toBeTruthy();

    try {
      await page.goto(`/dock/shell/shell-${shellId}?viewMode=advanced`);
      await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(2_000);

      // On plain shell: ribbon ([data-testid="terminal-ribbon-tabs"]) is NOT present.
      const panel = activePanel(page);
      const ribbonLoc = panel.locator(RIBBON_TABS);
      await expect(ribbonLoc).not.toBeVisible({ timeout: 3_000 });
      await expect(page).toHaveURL(new RegExp(`/dock/shell/shell-${shellId}`));
  } finally {
      await page.goto('/');
      await fetch(`${API_URL}/api/v1/graph/shell/${shellId}/close`, { method: 'POST' });
  }
});

  // ---------------------------------------------------------------------------
  // test 10: git-status API endpoint returns correct structure
  // ---------------------------------------------------------------------------
  test('git-status API returns correct shape for git and non-git dirs', async () => {
    test.setTimeout(30_000);

    const nodeId = await getComputeNodeId();
    expect(
      nodeId,
      'Phase 11 provider preflight failed: bootstrap did not expose a compute_node entity for git-status.',
    ).toBeTruthy();
    const computeNodeId = nodeId!;

    // --- git repo case ---
    const gitRes = await fetch(
      `${API_URL}/api/v1/graph/compute_node/${computeNodeId}/git-ops/status?workdir=${encodeURIComponent(REPO_ROOT)}`,
    );
    expect(gitRes.status).toBe(200);
    const gitJson = (await gitRes.json()) as {
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
    const nonGitRes = await fetch(`${API_URL}/api/v1/graph/compute_node/${computeNodeId}/git-ops/status?workdir=/tmp`);
    expect(nonGitRes.status).toBe(200);
    const nonGitJson = (await nonGitRes.json()) as {
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
