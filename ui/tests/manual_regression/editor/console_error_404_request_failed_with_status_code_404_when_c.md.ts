import { expect, test } from '@playwright/test';

// Filters cross-cutting console noise that is not the regression under test.
// Stale user-typeid 404s after a DB clear are filtered per the 2026-05-07 learning.
function realConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('Error fetching entity by type ID: user-') &&
      !e.includes('ERR_CONNECTION_REFUSED'),
  );
}

test.describe('Code editor — no 404 console errors (FLOWPAD-1686)', () => {
  test('navigating to /dock/editor does not produce 404 console errors', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/editor');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    // The editor dock renders inside the content panel.
    await expect(page.locator('[data-testid="content-panel"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_000);

    const status404 = errors.filter((e) => /404/.test(e));
    expect(status404, `404 console errors: ${status404.join('\n')}`).toHaveLength(0);
    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
