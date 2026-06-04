import { expect, test } from '@playwright/test';

function realConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('Error fetching entity by type ID: user-') &&
      !e.includes('ERR_CONNECTION_REFUSED') &&
      !/agent_hook\/.*\/watch/.test(e),
  );
}

test.describe('File explorer is accessible and shows directory contents (FLOWPAD-1603)', () => {
  test('explorer shows at least one directory/file item', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/explorer');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });

    // The file explorer surface is visible.
    await expect(page.locator('[data-testid="file-manager-download-button"]')).toBeAttached({ timeout: 15_000 });

    // Navigate to the VFS root, which lists directory contents.
    await page.locator('[data-testid="file-manager-home-button"]').click();
    await page.waitForTimeout(2_500);

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const rowCount = await rows.count();
    expect(rowCount, 'No directory/file items shown in explorer').toBeGreaterThan(0);

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
