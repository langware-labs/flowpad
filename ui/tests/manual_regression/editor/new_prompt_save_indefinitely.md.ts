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

test.describe('Execute flow view is accessible and does not hang (FLOWPAD-1657)', () => {
  test('execute-flow dock loads, controls are present and not stuck loading', async ({ page }) => {
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

    // The view exposes interactive controls (buttons/inputs) — not an indefinite spinner.
    const hasControl = await page
      .locator('[data-testid="content-panel"] button, [data-testid="content-panel"] input, [data-testid="content-panel"] textarea')
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    expect(hasControl, 'No interactive control found in execute-flow view').toBe(true);

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
