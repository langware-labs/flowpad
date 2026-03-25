/**
 * Regression test: navigating to /dock/cron now shows the unified Triggers view.
 *
 * After the merge, ViewType.CRON renders TriggersView instead of CronView.
 * This test verifies:
 * - /dock/cron loads without 404 or crash
 * - The Triggers view is displayed (not a blank screen or old CronView)
 * - "Schedule Triggers" section is visible
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

test('navigating to /dock/cron shows the unified Triggers view', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  await dismissSetupModal(page);

  await page.goto('/dock/cron');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  // The unified triggers view should be visible
  await page.locator('text=Triggers').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('text=Schedule Triggers').waitFor({ state: 'visible', timeout: 10_000 });

  // Should NOT show old CronView content (header with "+ New" for cron events)
  const oldCronHeader = page.locator('text=Schedules');
  const hasOldCron = await oldCronHeader.isVisible({ timeout: 1_000 }).catch(() => false);
  expect(hasOldCron).toBe(false);

  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
