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
import { adjusted } from '../../adjustableTimeout';

async function tabNames(page: import('@playwright/test').Page): Promise<string[]> {
  // The tab is a <div> whose FIRST <span> is a decorative active-indicator bar
  // (empty text); the label lives in a later <span>. Read the first span that
  // actually has text rather than `querySelector('span')` (which grabs the
  // empty indicator and gets filtered out, yielding an empty list).
  return page.locator('[data-testid^="tab-shell|"]').evaluateAll((els) =>
    els
      .map(
        (e) =>
          // The chip's name at every density (a crowded strip renders icon-only chips, no title text).
          e.getAttribute('data-tab-title') ||
          [...e.querySelectorAll('span')].map((s) => (s.textContent || '').trim()).find(Boolean) ||
          '',
      )
      .filter(Boolean),
  );
}

test.describe('incremented tab names', () => {
  test('test 1: second terminal tab name increments (distinct from the first)', async ({ page }) => {
    test.setTimeout(adjusted(60_000));
    await dismissSetupModal(page);
    await gotoShell(page);

    const before = await tabNames(page);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const firstName = before[0];

    const tabsBefore = await page.locator('[data-testid^="tab-shell|"]').count();
    await addTerminalTab(page);
    await expect(page.locator('[data-testid^="tab-shell|"]')).toHaveCount(tabsBefore + 1, { timeout: adjusted(15_000) });

    // The new tab gets its own, incremented name (e.g. "Tab 1" + "Tab 2"): distinct from every tab
    // already open. Tabs other scenarios left behind on this instance (agent sessions keep their
    // own default title) are not this scenario's to judge, so only the added one is compared.
    await expect(async () => {
      const names = await tabNames(page);
      expect(names.length).toBe(before.length + 1);
      const added = [...names];
      for (const n of before) if (added.includes(n)) added.splice(added.indexOf(n), 1);
      expect(added).toHaveLength(1);
      expect(before).not.toContain(added[0]); // a fresh name, not a copy of an open tab's
      expect(names.filter((n) => n === firstName).length).toBe(1); // first not duplicated
    }).toPass({ timeout: adjusted(10_000) });
  });
});
