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

test.describe('File explorer shows Unix-style root (not Windows C:/) on macOS (FLOWPAD-1594)', () => {
  test('root path is Unix-style and never shows C:\\ or C:/', async ({ page }) => {
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

    // Navigate to the VFS root.
    await page.locator('[data-testid="file-manager-home-button"]').click();
    await page.waitForTimeout(2_500);
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // The displayed path must not show a Windows drive root.
    const explorerText = await page.locator('[data-testid="content-panel"]').innerText();
    expect(explorerText, 'Explorer surfaced a Windows-style C: root').not.toMatch(/C:\\|C:\//);

    // It shows Unix-style top-level directories.
    await expect(rows.filter({ hasText: /Users|System|usr/ }).first()).toBeVisible({ timeout: 10_000 });

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
