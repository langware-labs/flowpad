import { expect, test } from '@playwright/test';

// The cross-cutting agent_hook/<id>/watch console noise is a separate ticket — filter it.
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

test.describe('File explorer download control is present (FLOWPAD-1605)', () => {
  test('SimpleFileManager renders the Download control', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/explorer');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Download control is present in the DOM (may be disabled with nothing selected — that's fine).
    const downloadBtn = page.locator('[data-testid="file-manager-download-button"]');
    await expect(downloadBtn).toBeAttached({ timeout: 15_000 });

    // The control carries the Lucide Download icon (the "Download" tooltip wraps this same button).
    const hasDownloadIcon = await downloadBtn
      .locator('svg.lucide-download, svg[class*="lucide-download"]')
      .count();
    expect(hasDownloadIcon, 'Download control does not contain a Lucide Download icon').toBeGreaterThan(0);

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
