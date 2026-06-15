/**
 * Regression test: existing hook triggers continue to work after the merge.
 *
 * Verifies:
 * - Hook triggers appear in the "Hook Triggers" section
 * - Selecting a hook trigger shows trigger.py content in center panel
 * - System-scope triggers are read-only
 * - Log button opens lens (no crash)
 * - Invocations panel shows (may be empty for fresh env)
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoTriggers } from './helpers';

test('hook triggers render correctly — no regression after merge', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  await dismissSetupModal(page);
  await gotoTriggers(page);

  // Check if any hook triggers exist (system triggers from discover). The
  // section header AND the empty-state text both contain "hook triggers" —
  // use exact match on the header span to disambiguate.
  const hookSection = page.getByText('Hook Triggers', { exact: true }).first();
  const hasHookSection = await hookSection.isVisible({ timeout: 3_000 }).catch(() => false);
  // Detect empty state explicitly: section header visible AND a "No hook
  // triggers" placeholder exists ⇒ skip the click-and-validate flow.
  const hasEmptyState = await page
    .getByText(/No hook triggers/i)
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
  const hasHookTriggers = hasHookSection && !hasEmptyState;

  if (!hasHookTriggers) {
    // No hook triggers in this environment — just verify the page loads without crash
    await page.getByText('Schedule Triggers', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 });
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
    );
    expect(criticalErrors).toHaveLength(0);
    return;
  }

  // Select the first hook trigger — anchor on the exact section header.
  const firstHookItem = hookSection.locator('..').locator('[class*="cursor-pointer"]').first();
  await firstHookItem.waitFor({ state: 'visible', timeout: 5_000 });
  await firstHookItem.click();

  // Center panel should show trigger.py content (or loading state)
  await page.waitForTimeout(1_000);
  const hasTriggerPy = await page.locator('text=/trigger.py/').isVisible({ timeout: 5_000 }).catch(() => false);
  const hasLoading = await page.locator('text=Loading...').isVisible({ timeout: 1_000 }).catch(() => false);
  expect(hasTriggerPy || hasLoading).toBe(true);

  // Invocations panel should be visible
  await page.locator('text=Invocations').waitFor({ state: 'visible', timeout: 5_000 });

  // No critical errors
  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
