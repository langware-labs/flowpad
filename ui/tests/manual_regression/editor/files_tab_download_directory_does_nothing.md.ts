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

test.describe('File explorer shows files and directories correctly (FLOWPAD-1671)', () => {
  test('directory rows are visible and the per-file download control is wired', async ({ page }) => {
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

    await page.goto('/dock/explorer');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Navigate to the VFS root, which lists top-level directories.
    await page.locator('[data-testid="file-manager-home-button"]').click();
    await page.waitForTimeout(2_500);

    // Row elements are present in the file list area.
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const rowCount = await rows.count();
    expect(rowCount, 'No file/directory rows rendered at VFS root').toBeGreaterThan(0);

    // At least one directory entry is visible (root is all directories on a Unix host).
    const dirRow = rows.filter({ hasText: /Users|System|Library|bin|usr/ }).first();
    await expect(dirRow).toBeVisible({ timeout: 10_000 });

    // The download control is wired up, even when disabled for the empty-selection state.
    await expect(page.locator('[data-testid="file-manager-download-button"]')).toBeAttached({ timeout: 10_000 });

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
