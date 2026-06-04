/**
 * Shell tabs remain open after closing (FLOWPAD-1610).
 * Source: shell_tabs_remain_open_after_closing.md
 *
 * Open 5 extra terminals, close 3 of them, reload. Only the 2 un-closed extra
 * tabs (plus the original Flow shell) survive the reload — closing a tab
 * persists its removal so a refresh does not resurrect it, and the un-closed
 * tabs are not lost.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

async function tabIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid^="tab-shell-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean));
}

test.describe('Shell tabs remain open after closing', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 1: 2 additional tabs remain open after closing 3 of 5 and refreshing', async ({ page }) => {
    test.setTimeout(180_000);

    // Step 1: navigate to the app shell tab (default Flow shell).
    await gotoShell(page);
    const beforeAdds = new Set(await tabIds(page));

    // Step 2: open 5 terminals. Track the ids that are new since the baseline.
    for (let i = 0; i < 5; i++) {
      await addTerminalTab(page);
    }
    let added: string[] = [];
    await expect(async () => {
      added = (await tabIds(page)).filter((id) => !beforeAdds.has(id));
      expect(added.length).toBe(5);
    }).toPass({ timeout: 20_000 });

    // Step 3: close 3 of the newly-opened terminals via their X buttons.
    const toClose = added.slice(0, 3);
    const toKeep = added.slice(3); // 2 remaining
    for (const id of toClose) {
      const tab = page.locator(`[data-testid="${id}"]`);
      await tab.hover(); // X appears on hover
      await tab.locator('button[aria-label="Close tab"]').click();
      await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(0, { timeout: 15_000 });
    }

    // Step 4: refresh the page.
    await page.reload();
    const skipForNow = page.getByRole('button', { name: 'Skip for now' });
    if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await skipForNow.click();
    }
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible({ timeout: 30_000 });

    // Step 5: only the 2 un-closed additional terminals remain (closed ones
    // stay closed; kept ones survive). The original Flow shell also remains.
    for (const id of toKeep) {
      await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(1, { timeout: 15_000 });
    }
    for (const id of toClose) {
      await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(0, { timeout: 15_000 });
    }

    // Exactly the baseline (Flow shell) + 2 kept additional tabs.
    await expect
      .poll(async () => (await tabIds(page)).length, { timeout: 15_000 })
      .toBe(beforeAdds.size + 2);
  });
});
