import { expect, test } from '@playwright/test';

function realConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('Error fetching entity by type ID: user-') &&
      !e.includes('ERR_CONNECTION_REFUSED'),
  );
}

test.describe('Execute flow view loads without theme errors (FLOWPAD-1668)', () => {
  test('execute-flow dock loads without vs-dark / theme console errors', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/execute-flow');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="content-panel"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_000);

    const themeErrors = errors.filter((e) => /vs-dark|theme.*not found|need to load.*theme/i.test(e));
    expect(themeErrors, `Theme console errors: ${themeErrors.join('\n')}`).toHaveLength(0);
    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
