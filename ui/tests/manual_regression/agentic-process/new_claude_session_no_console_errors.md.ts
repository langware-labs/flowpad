/**
 * Regression test: no console errors when creating a new Claude session.
 *
 * Bugs found and fixed 2026-03-07:
 * 1. `bytes is not defined` — const inside try block referenced outside (shellManager.ts)
 * 2. `Maximum update depth exceeded` — inline [] dep in useScrollSync caused infinite render loop
 * 3. `Error parsing message` — compute-node.ts WS handler got string, used as TypeId object
 */
import { test, expect } from '@playwright/test';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test('creating a Claude session produces no console errors', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await dismissSetupModal(page);
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(2_000);

  // Start Claude via the always-present "+" tab-opener menu.
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-claude"]').click();
  await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 20_000 });
  await page.waitForTimeout(3_000);

  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('ResizeObserver') &&
    !e.includes('net::ERR_'),
  );

  if (criticalErrors.length > 0) {
    console.log('Console errors found:', criticalErrors);
  }
  expect(criticalErrors).toHaveLength(0);
});
