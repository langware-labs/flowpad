/**
 * Regression tests: Prompt Index Panel (Unified Side Window)
 *
 * Feature: A MessageSquare icon in the TerminalBottomRibbon (agentic process terminals only)
 * opens a Prompts tab in the unified side window listing merged prompts from annotation elements
 * (kind==='prompt') and UserMessage trace events, deduped and sorted by timestamp.
 *
 * Key files:
 *   ui/src/components/terminal/interactive-terminal/side-windows/PromptIndexPanel.tsx
 *   ui/src/components/terminal/interactive-terminal/side-windows/SideWindow.tsx
 *   ui/src/components/terminal/interactive-terminal/TerminalBottomRibbon.tsx
 *   ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx
 *
 * Implementation notes:
 *   - Side window container: .w-80.flex-col.border-l (SideWindow)
 *   - Tab strip: first .border-b inside the side window
 *   - Prompts tab × close button: button[aria-label="Close Prompts"]
 *   - PromptIndexPanel inner header has NO close button — closing is via tab strip ×
 *   - Ribbon .ml-auto button order: 0=Context, 1=Git, 2=Prompts, 3=Files, 4=Dir
 *   - Buttons have NO title attribute — they use tooltips on hover
 *   - Prompt count badge is a lime pill on the Prompts button (index 2)
 *
 * Tests 1–4 and 10 are fully automatable (no live Claude needed).
 * Tests 5–9, 11–12 require live Claude data or visual inspection.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, startClaudeSession } from './helpers';

/**
 * Cache the agentic process URL after the first successful navigation.
 * Reusing it avoids repeated new_terminal round-trips (each of which creates
 * a new shell entity and can land on a freshly-starting Claude instance that
 * takes >60s before the ribbon appears).
 */
let cachedAgenticUrl: string | null = null;

/**
 * Navigate to a shell and ensure we end up on an agentic process URL.
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
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await startClaudeSession(page);
    await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 60_000 });
  }

  // Wait for the ribbon to be visible (can take >8s on a fresh process).
  await expect(ribbon).toBeVisible({ timeout: 60_000 });

  // The ribbon/toolbar re-renders continuously while the worker initializes
  // (status updates via useSyncExternalStore) — a click issued mid-churn keeps
  // re-resolving a detaching button and can retry until the test cap. Let it
  // settle before callers drive the buttons (same settle as _ap_helpers).
  await page.waitForTimeout(3_000);

  // Cache URL for subsequent tests in this run.
  cachedAgenticUrl = page.url();
}

/**
 * Get the side window container (w-80 flex-col border-l).
 */
function getSideWindow(page: import('@playwright/test').Page) {
  // Every open tab keeps its terminal panel mounted in the DOM, each with its
  // own side-window container — scope to the ACTIVE panel or the locator
  // resolves to 2+ elements and trips strict mode.
  return page
    .locator('[data-testid="terminal-panel"][data-active="true"]')
    .locator('.w-80.flex-col.border-l');
}


/**
 * Idempotently OPEN a side tab via its ribbon button. Ribbon buttons TOGGLE:
 * with cachedAgenticUrl reuse, a tab left open by an earlier test would be
 * CLOSED by a blind click — check the tab strip first.
 */
async function ensureSideTabOpen(page: import('@playwright/test').Page, buttonIndex: number, tabLabel: string) {
  const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
  const tabStrip = getSideWindow(page).locator('.border-b').first();
  const already = await tabStrip.getByText(tabLabel, { exact: true }).isVisible({ timeout: 1_000 }).catch(() => false);
  if (!already) await activePanel.locator('.border-t .ml-auto button').nth(buttonIndex).click();
  await tabStrip.getByText(tabLabel, { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
}

/** Idempotently CLOSE a side tab (via its × button) so toggle tests start closed. */
async function ensureSideTabClosed(page: import('@playwright/test').Page, tabLabel: string) {
  const closeBtn = page.locator('[data-testid="terminal-panel"][data-active="true"]').locator(`button[aria-label="Close ${tabLabel}"]`);
  if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeBtn.click();
    await closeBtn.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
  }
}

test.describe('Prompt Index Panel', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ---------------------------------------------------------------------------
  // test 1: Prompt icon appears in agentic process terminal ribbon
  // ---------------------------------------------------------------------------
  test('prompt index icon appears in agentic process terminal ribbon', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    // Validate ribbon is visible — check the ml-auto button container
    // (text=/running|idle/i is unreliable: may match a visibility:hidden tooltip element)
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');
    await expect(mlAuto).toBeVisible({ timeout: 15_000 });

    // Prompts button is at index 2 in .ml-auto:
    // Context(0), Git(1), Prompts(2), Files(3), Dir(4)
    await expect(mlAuto.locator('button').nth(2)).toBeVisible({ timeout: 15_000 });

    // Validate all 7 buttons are present (6 ribbon side-tabs incl. Queue + Prompt Library; 55a71046)
    await expect(mlAuto.locator('button')).toHaveCount(7, { timeout: 5_000 });

    // Files button should also be visible (index 3)
    await expect(mlAuto.locator('button').nth(3)).toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // test 2: Prompt panel opens as a tab in the side window
  // ---------------------------------------------------------------------------
  test('prompt panel opens as a tab in the side window', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    // Click the Prompts button (index 2 in .ml-auto)
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await ensureSideTabOpen(page, 2, 'Prompts');

    // Side window should appear
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Tab strip shows "Prompts" tab with × close button
    const tabStrip = sideWindow.locator('.border-b').first();
    await expect(tabStrip.getByText('Prompts')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="terminal-panel"][data-active="true"]').locator('button[aria-label="Close Prompts"]')).toBeVisible({ timeout: 5_000 });

    // Inner panel header shows "Prompts (" with NO close button
    const panelHeader = sideWindow.locator('.flex-1').getByText(/Prompts \(/);
    await expect(panelHeader).toBeVisible({ timeout: 5_000 });

    // Either "No prompts yet" or a list of prompt items
    const emptyMsg = page.getByText('No prompts yet');
    const hasEmpty = await emptyMsg.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!hasEmpty) {
      // Panel has prompts — verify at least one item is rendered
      const promptItem = sideWindow.locator('.cursor-pointer').first();
      await expect(promptItem).toBeVisible({ timeout: 5_000 });
    }
  });

  // ---------------------------------------------------------------------------
  // test 3: Prompt tab closes via × in the tab strip
  // ---------------------------------------------------------------------------
  test('prompt tab closes via the × close button in the tab strip', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    // Open the panel
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await ensureSideTabOpen(page, 2, 'Prompts');

    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Close via tab strip ×
    await page.locator('[data-testid="terminal-panel"][data-active="true"]').locator('button[aria-label="Close Prompts"]').click();

    // Side window should disappear (no tabs remain)
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // test 4: Clicking ribbon button when Prompts is already active does NOT close the panel
  // ---------------------------------------------------------------------------
  test('clicking ribbon button toggles the Prompts tab — second click closes it', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await ensureSideTabClosed(page, 'Prompts');
    const promptsBtn = activePanel.locator('.border-t .ml-auto button').nth(2);

    // First click — opens
    await promptsBtn.click();
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Second click — closes (toggle: active tab is closed when its button is clicked again)
    await promptsBtn.click();
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });

    // Third click — re-opens
    await promptsBtn.click();
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });

    // Close via tab strip × to clean up
    await page.locator('[data-testid="terminal-panel"][data-active="true"]').locator('button[aria-label="Close Prompts"]').click();
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // test 10: Prompt icon is absent for plain shell terminals (no process)
  // ---------------------------------------------------------------------------
  test('prompt icon is absent in plain shell terminal (no agentic process)', async ({ page }) => {
    test.setTimeout(60_000);

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

    // On plain shell: ribbon (.border-t .ml-auto) must not be visible
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');
    await expect(mlAuto).not.toBeVisible({ timeout: 3_000 });
  });

  // ---------------------------------------------------------------------------
  // test 12: Multiple panels are tabs in the same side window (not side-by-side)
  // ---------------------------------------------------------------------------
  test('Files and Prompts panels coexist as tabs in the same side window', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcess(page);

    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const mlAuto = activePanel.locator('.border-t .ml-auto');

    // Open Files (index 3)
    await mlAuto.locator('button').nth(3).click();
    const sideWindow = getSideWindow(page);
    await expect(sideWindow).toBeVisible({ timeout: 5_000 });
    // Use tab strip + exact match to avoid strict-mode violation (other elements contain 'Files')
    const tabStrip = sideWindow.locator('.border-b').first();
    await expect(tabStrip.getByText('Files', { exact: true })).toBeVisible({ timeout: 3_000 });

    // Open Prompts (index 2) — should add to the same side window
    await mlAuto.locator('button').nth(2).click();
    await expect(tabStrip.getByText('Prompts', { exact: true })).toBeVisible({ timeout: 3_000 });

    // Both tabs should be in the same tab strip
    await expect(tabStrip.getByText('Files', { exact: true })).toBeVisible();
    await expect(tabStrip.getByText('Prompts', { exact: true })).toBeVisible();

    // Only ONE side window should exist (panels share a single 320px container, not stacked)
    await expect(getSideWindow(page)).toHaveCount(1);

    // Switch to Files tab
    await tabStrip.getByText('Files', { exact: true }).click();

    // Close both tabs sequentially — side window disappears. The tab list lives
    // in the URL (?sideWindows=…), so each Close navigates; fire them back-to-back
    // and the second close closes over the stale pre-nav list (last-writer-wins
    // leaves one tab open). Wait for the first tab to drop before the second click.
    await page.locator('[data-testid="terminal-panel"][data-active="true"]').locator('button[aria-label="Close Files"]').click();
    await expect(tabStrip.getByText('Files', { exact: true })).not.toBeVisible({ timeout: 3_000 });
    await page.locator('[data-testid="terminal-panel"][data-active="true"]').locator('button[aria-label="Close Prompts"]').click();
    await expect(sideWindow).not.toBeVisible({ timeout: 5_000 });
  });
});
