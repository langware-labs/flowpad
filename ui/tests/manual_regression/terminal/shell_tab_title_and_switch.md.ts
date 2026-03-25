import { test, expect, type Page } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

/**
 * Shell Tab Title & Switch Regression
 *
 * Validates:
 * 1. Shell tabs created via "+" can be renamed via double-click UI
 * 2. Tab titles survive page refresh (persisted via shell.updateDisplay)
 * 3. Tab switching works after refresh (no redirect to first tab)
 *
 * Uses plain shell tabs (open-terminal-tab-button) + double-click rename to avoid
 * relying on Claude CLI /rename which may be overwritten on reconnect.
 */

/** Get the text of all tab labels, in order */
async function getTabNames(page: Page): Promise<string[]> {
  const tabs = page.locator('[data-testid^="tab-"] span.font-medium');
  const count = await tabs.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await tabs.nth(i).textContent();
    names.push(text?.trim() || '');
  }
  return names;
}

/** Get the name of the currently active (selected) tab */
async function getActiveTabName(page: Page): Promise<string> {
  const allTabs = page.locator('[data-testid^="tab-"]');
  const count = await allTabs.count();
  for (let i = 0; i < count; i++) {
    const tab = allTabs.nth(i);
    const cls = await tab.getAttribute('class');
    if (cls?.includes('border-primary')) {
      // Use span.font-medium (the name span) — the first span is the status dot (no text).
      const text = await tab.locator('span.font-medium').first().textContent();
      return text?.trim() || '';
    }
  }
  return '';
}

/**
 * Check if a tab name matches the expected rename value.
 */
function tabNameMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(` ${expected}`) || actual.endsWith(expected);
}

/** Click a tab whose name ends with the given text */
async function clickTabByName(page: Page, tabName: string) {
  const allTabs = page.locator('[data-testid^="tab-"]');
  const count = await allTabs.count();
  for (let i = 0; i < count; i++) {
    const tab = allTabs.nth(i);
    // Use span.font-medium (the name span) — the first span is the status dot (no text).
    const text = await tab.locator('span.font-medium').first().textContent();
    if (text && tabNameMatches(text.trim(), tabName)) {
      await tab.click({ force: true });
      await page.waitForTimeout(500);
      return;
    }
  }
  throw new Error(`Tab "${tabName}" not found. Available tabs: ${await getTabNames(page)}`);
}

/** Wait for a tab whose name matches the expected value */
async function waitForTabName(page: Page, name: string, timeout = 15_000) {
  await expect(async () => {
    const names = await getTabNames(page);
    const found = names.some((n) => tabNameMatches(n, name));
    expect(found).toBe(true);
  }).toPass({ timeout });
}


test.describe('Shell Tab Title and Switching', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('rename tabs, refresh, and switch between them', async ({ page }) => {
    test.setTimeout(120_000);

    // Use timestamps so these tabs are findable even if other tabs exist.
    // Do NOT close all existing tabs — with many accumulated sessions that
    // takes minutes and the test times out.
    const ts = Date.now();
    const name1 = `t1-${ts}`;
    const name2 = `t2-${ts}`;

    // Step 1: Navigate to shell (creates a new terminal, waits for xterm init)
    await gotoShell(page);

    const addTerminalButton = page.locator('[data-testid="open-terminal-tab-button"]');

    /** Create a tab, detect it by testid diff, rename it via dispatchEvent('dblclick'). */
    async function createAndRename(newName: string): Promise<string> {
      // Snapshot existing testids before adding
      const before = new Set(
        await page.locator('[data-testid^="tab-"]').evaluateAll(
          (els) => els.map((el) => el.getAttribute('data-testid') ?? ''),
        ),
      );

      await addTerminalButton.click();

      // Wait for a new tab to appear
      let newTestId = '';
      await expect(async () => {
        const current = await page.locator('[data-testid^="tab-"]').evaluateAll(
          (els) => els.map((el) => el.getAttribute('data-testid') ?? ''),
        );
        const fresh = current.filter((id) => id && !before.has(id));
        expect(fresh.length).toBeGreaterThan(0);
        newTestId = fresh[0];
      }).toPass({ timeout: 10_000 });

      const tab = page.locator(`[data-testid="${newTestId}"]`);
      // Force-click to activate + scroll into view, then dispatchEvent to avoid
      // overflow-scroll interception in a crowded tab strip
      await tab.click({ force: true });
      await page.waitForTimeout(200);
      await tab.locator('span.font-medium').dispatchEvent('dblclick');
      await page.waitForTimeout(300);

      const renameInput = tab.locator('input[type="text"]');
      await expect(renameInput).toBeVisible({ timeout: 5_000 });
      await renameInput.click({ clickCount: 3 });
      await renameInput.type(newName);
      await renameInput.press('Enter');
      await waitForTabName(page, newName, 10_000);
      return newTestId;
    }

    // Step 2–3: Create and rename first tab
    await createAndRename(name1);

    // Step 4–5: Create and rename second tab
    await createAndRename(name2);

    // Step 6: Switch to first tab
    await clickTabByName(page, name1);
    await page.waitForTimeout(500);
    const activeAfterSwitch = await getActiveTabName(page);
    expect(tabNameMatches(activeAfterSwitch, name1)).toBe(true);

    // Step 7: Refresh
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // Step 8: Both renamed tabs must survive refresh (updateDisplay persists to backend)
    await waitForTabName(page, name1, 15_000);
    await waitForTabName(page, name2, 15_000);

    // Step 9: Click name2
    await clickTabByName(page, name2);
    await page.waitForTimeout(500);

    // Step 10: name2 must be active (not redirected to first tab)
    const activeAfterClick = await getActiveTabName(page);
    expect(tabNameMatches(activeAfterClick, name2)).toBe(true);
  });
});
