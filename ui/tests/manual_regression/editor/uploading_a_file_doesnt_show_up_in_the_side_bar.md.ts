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

test.describe('File explorer sidebar shows file contents (FLOWPAD-1654)', () => {
  test('explorer sidebar/tree surfaces directory structure with entries', async ({ page }) => {
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
    await expect(page.locator('[data-testid="file-manager-download-button"]')).toBeAttached({ timeout: 15_000 });

    // Navigate to the VFS root and confirm entries are surfaced (not an empty list).
    await page.locator('[data-testid="file-manager-home-button"]').click();
    await page.waitForTimeout(2_500);

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const count = await rows.count();
    expect(count, 'Explorer shows an empty list at VFS root').toBeGreaterThan(0);

    // The explorer's sidebar/tree panel is present and surfaces the directory
    // structure. `/dock/explorer` renders the ExplorerNavigator (NavigatorPanel,
    // testid `navigator-panel-explorer`) as its sidebar and a `browseable-*` fs
    // tree. (This note used to contrast with a separate `directory-tree`
    // component; the code editor now builds on the same browseable tree, so
    // there is only one.) Assert the real panel and that at least one
    // filesystem tree entry (the VFS root chevron) is present.
    const sidebar = page.locator('[data-testid="navigator-panel-explorer"]');
    await expect(sidebar).toBeAttached({ timeout: 10_000 });
    await expect(
      sidebar.locator('[data-testid^="browseable-chevron-fs-"]').first(),
    ).toBeAttached({ timeout: 10_000 });

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
