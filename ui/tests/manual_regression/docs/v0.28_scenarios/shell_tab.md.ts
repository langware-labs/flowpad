/**
 * Two independent shell tabs accept input and display their own output.
 * Source: shell_tab.md
 */
import { expect, test, type Page } from '@playwright/test';

async function sendMarker(page: Page, marker: string) {
  const panel = page.locator('[data-testid="terminal-panel"][data-active="true"]').last();
  await panel.click({ force: true });
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows').first()).toContainText(marker);
}

test.describe('Shell tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('viewMode', 'advanced');
    });
  });

  test('two fresh terminals are responsive and isolated', async ({ page }) => {
    await page.goto('/dock/shell/new_terminal');
    await expect(page).toHaveURL(/\/dock\/shell\/shell-[\w-]+$/);
    const firstSession = page.url().split('/').pop();
    await expect(
      page.locator(`[data-testid="terminal-panel"][data-session-id="${firstSession}"] .xterm-rows`).first(),
    ).toBeAttached();
    await sendMarker(page, 'TERMINAL_ONE_READY');

    await page.getByTestId('opener-plus-button').click();
    await page.getByTestId('opener-menu-row-terminal').click();
    await expect(page).toHaveURL(/\/dock\/shell\/shell-[\w-]+$/);
    const secondSession = page.url().split('/').pop();
    expect(secondSession).not.toBe(firstSession);
    await expect(
      page.locator(`[data-testid="terminal-panel"][data-session-id="${secondSession}"] .xterm-rows`).first(),
    ).toBeAttached();
    await sendMarker(page, 'TERMINAL_TWO_READY');

    await expect(
      page.locator(`[data-testid="terminal-panel"][data-session-id="${firstSession}"] .xterm-rows`).first(),
    ).toContainText('TERMINAL_ONE_READY');
  });
});
