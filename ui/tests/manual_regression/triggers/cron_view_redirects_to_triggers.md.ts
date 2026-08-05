/**
 * Regression test: the old screen URLs still resolve after the merge.
 *
 * `triggers`, `signals` and `cron` are ALIASES of the Events view — same body,
 * same navigator — rather than redirects, so a bookmarked URL keeps working
 * instead of bouncing. Covers all four entry points, including `/dock/cron`,
 * which was already an alias of Triggers before this merge.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

const ALIASES = ['/dock/cron', '/dock/triggers', '/dock/signals', '/dock/events'];

for (const url of ALIASES) {
  test(`${url} shows the merged Events view`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));

    await dismissSetupModal(page);

    await page.goto(url);
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

    // The rules navigator (Zone B) and the match-mode sections it groups by.
    await page.getByText('Rules', { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('On schedule', { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    // The old per-type headings are gone — rules are match modes now.
    const oldHeading = page.getByText('Schedule Triggers', { exact: true });
    expect(await oldHeading.isVisible({ timeout: 1_000 }).catch(() => false)).toBe(false);

    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
    );
    expect(criticalErrors).toHaveLength(0);
  });
}
