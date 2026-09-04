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

test.describe('System profile — no 500 console errors (FLOWPAD-1659)', () => {
  test('navigating to /dock/system_profile does not produce 500 console errors', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/system_profile');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="content-panel"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_000);

    const status500 = errors.filter((e) => /\b500\b/.test(e));
    expect(status500, `500 console errors: ${status500.join('\n')}`).toHaveLength(0);
    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
