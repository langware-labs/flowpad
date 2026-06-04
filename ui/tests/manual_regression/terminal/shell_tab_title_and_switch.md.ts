import { test, expect, type Page } from '@playwright/test';
import { dismissSetupModal, gotoShell, openTabViaMenu } from './helpers';

/**
 * Shell Tab Title & Switch Regression
 *
 * Validates:
 * 1. Shell tabs created via "+" can be renamed via double-click UI
 * 2. Tab titles survive page refresh (persisted via shell.updateDisplay)
 * 3. Tab switching works after refresh (no redirect to first tab)
 *
 * Uses plain shell tabs (opener menu → terminal row) + double-click rename to avoid
 * relying on Claude CLI /rename which may be overwritten on reconnect.
 */

/** Get the text of all tab labels, in order */
async function getTabNames(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="tab-"]').evaluateAll((els) =>
    els.map((el) => (el.querySelector('span.font-medium')?.textContent ?? '').trim()),
  );
}

/** Get the name of the currently active (selected) tab */
async function getActiveTabName(page: Page): Promise<string> {
  return page.locator('[data-testid^="tab-"]').evaluateAll((els) => {
    for (const el of els) {
      if ((el.getAttribute('class') ?? '').includes('border-primary')) {
        return (el.querySelector('span.font-medium')?.textContent ?? '').trim();
      }
    }
    return '';
  });
}

/**
 * Check if a tab name matches the expected rename value.
 */
function tabNameMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(` ${expected}`) || actual.endsWith(expected);
}

/** Click a tab whose name ends with the given text */
async function clickTabByName(page: Page, tabName: string) {
  // Read all tab names + testids in a single DOM evaluation — iterating with
  // playwright locators on a crowded tab strip stalls when one tab lacks the
  // expected `span.font-medium` and the per-tab textContent locator hangs
  // until the per-test timeout.
  const matched = await page.locator('[data-testid^="tab-"]').evaluateAll((els, expected) => {
    function matches(actual: string): boolean {
      return actual === expected || actual.endsWith(' ' + expected) || actual.endsWith(expected);
    }
    for (const el of els) {
      const span = el.querySelector('span.font-medium');
      const text = (span?.textContent ?? '').trim();
      if (text && matches(text)) {
        return el.getAttribute('data-testid');
      }
    }
    return null;
  }, tabName);
  if (!matched) {
    throw new Error(`Tab "${tabName}" not found. Available tabs: ${await getTabNames(page)}`);
  }
  await page.locator(`[data-testid="${matched}"]`).click({ force: true });
  await page.waitForTimeout(500);
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

    /** Create a tab, detect it by testid diff, rename it via the ContextMenu "Rename" item. */
    async function createAndRename(newName: string): Promise<string> {
      // Snapshot existing testids before adding
      const before = new Set(
        await page.locator('[data-testid^="tab-"]').evaluateAll(
          (els) => els.map((el) => el.getAttribute('data-testid') ?? ''),
        ),
      );

      await openTabViaMenu(page, 'terminal');

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
      // Open rename via the tab's ContextMenu "Rename" item (same handler as the
      // span dblclick — handleTabDoubleClick). The synthetic dblclick raced the
      // selectTab re-render and dropped the event under load; the context menu is
      // deterministic. The menu is portaled to body, so the menuitem is page-scoped.
      await tab.click({ force: true });
      await tab.click({ button: 'right', force: true });
      await page.getByRole('menuitem', { name: 'Rename' }).click();

      const renameInput = tab.locator('input[type="text"]');
      await expect(renameInput).toBeVisible({ timeout: 5_000 });
      // The product auto-focuses + selects-all the input on mount (TabbedTerminal
      // handleTabDoubleClick → useEffect input.focus()+setSelectionRange), so no
      // click is needed. fill() is also re-render-robust: it waits for stability
      // and sets the value atomically, surviving the streaming tab strip's churn
      // that detached the node under a manual click({clickCount:3}).
      await renameInput.fill(newName);
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
