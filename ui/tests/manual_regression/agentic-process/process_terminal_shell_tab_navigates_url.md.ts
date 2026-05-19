/**
 * Regression test: clicking a shell tab from agentic process view must update the URL.
 *
 * Bug fixed 2026-03-07: ProcessTerminal.handleSessionChange didn't call navigation.openShell(),
 * leaving the URL stuck on agentic_process-<id> while showing shell tab content.
 */
import { test, expect } from '@playwright/test';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test('clicking shell tab from agentic process view updates URL to shell session', async ({ page }) => {
  test.setTimeout(120_000);
  await dismissSetupModal(page);

  // Navigate to shell
  await page.goto('/dock/shell/new_terminal');
  const skipBtn = page.getByRole('button', { name: 'Skip' });
  if (await skipBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await skipBtn.click();
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(2_000);

  // Capture shell session ID from URL
  const shellUrl = page.url();
  const shellSessionMatch = shellUrl.match(/(shell-[\w-]+)/);
  const shellSessionId = shellSessionMatch ? shellSessionMatch[1] : null;
  if (!shellSessionId) throw new Error('Could not determine shell session ID from URL');

  const initialTabCount = await page.locator('[data-testid^="tab-shell-"]').count();

  // Start Claude via the always-present "+" tab-opener menu.
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-claude"]').click();
  await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 20_000 });

  // Wait for PTY tab to appear (confirms agentic process PTY started)
  await expect(page.locator('[data-testid^="tab-shell-"]')).toHaveCount(initialTabCount + 1, { timeout: 30_000 });

  // We're now in agentic_process view — click the original shell tab
  const shellTab = page.locator(`[data-testid="tab-${shellSessionId}"]`);
  await shellTab.waitFor({ state: 'visible', timeout: 5_000 });
  await shellTab.click();

  // URL must navigate to the shell session
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 10_000 });
  expect(page.url()).toContain(shellSessionId);
});
