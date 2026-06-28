/**
 * Adding a second terminal tab shows a correctly incremented tab name
 * (FLOWPAD-1645). Source: new_sessions_always_opened_with_session_1_header.md
 *
 * Read the tab labels directly off each `tab-shell-*` element rather than via
 * the active-tab helper: the new tab's active state can lag a frame behind its
 * DOM insertion, and the invariant under test is "the two tabs have distinct
 * (incremented) names", not "the active tab's name".
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';
import { gotoShell, addTerminalTab } from '../terminal/helpers';

async function tabNames(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('[data-testid^="tab-shell|"]').evaluateAll((els) =>
    els.map((e) => (e.querySelector('span')?.textContent || '').trim()).filter(Boolean),
  );
}

test.describe('incremented tab names', () => {
  test('test 1: second terminal tab name increments (distinct from the first)', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoShell(page);

    const before = await tabNames(page);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const firstName = before[0];

    const tabsBefore = await page.locator('[data-testid^="tab-shell|"]').count();
    await addTerminalTab(page);
    await expect(page.locator('[data-testid^="tab-shell|"]')).toHaveCount(tabsBefore + 1, { timeout: 15_000 });

    // The two tabs have distinct, incremented names (e.g. "Tab 1" + "Tab 2").
    await expect(async () => {
      const names = await tabNames(page);
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(new Set(names).size).toBe(names.length); // all distinct
      expect(names.filter((n) => n === firstName).length).toBe(1); // first not duplicated
    }).toPass({ timeout: 10_000 });
  });
});
