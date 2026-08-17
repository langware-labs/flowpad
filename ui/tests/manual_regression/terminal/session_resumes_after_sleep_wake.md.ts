/**
 * Terminal resumes after transport loss.
 * Source: session_resumes_after_sleep_wake.md
 *
 * A physical OS sleep remains a manual hardware check, but the product seam it
 * exercises is the browser WebSocket disconnect/reconnect path. Chromium
 * offline/online severs that transport without reloading the page, so this test
 * proves the existing tab remains usable after the sever, the PTY accepts and
 * renders new output, and explicit tab close still destroys rather than parks
 * the session. It intentionally does not couple to the WebSocket constructor:
 * reconnect may be owned below the page-level socket wrapper.
 */
import { expect, test, type Page } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';

async function typeInActiveTerminal(page: Page, text: string) {
  await page.locator('[data-testid="terminal-panel"][data-active="true"]').last().click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('terminal self-resumes after a real network sever without page reload', async ({ page, context }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });

  await page.goto(withViewMode('/dock/shell/new_terminal', 'advanced'));
  await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
  const shellUrl = page.url();
  const panel = page.locator('[data-testid="terminal-panel"][data-active="true"]').first();
  await expect(panel.locator('.xterm-rows')).toBeAttached();
  const activeTab = page.locator('[data-testid^="tab-"][data-active="true"]').first();
  const tabTestId = await activeTab.getAttribute('data-testid');
  expect(tabTestId).toBeTruthy();

  const beforeMarker = `before-sever-${Date.now()}`;
  await typeInActiveTerminal(page, `echo ${beforeMarker}`);
  await expect(panel.locator('.xterm-rows')).toContainText(beforeMarker);

  await context.setOffline(true);
  await context.setOffline(false);

  const afterMarker = `after-sever-${Date.now()}`;
  await typeInActiveTerminal(page, `echo ${afterMarker}`);
  await expect(panel.locator('.xterm-rows')).toContainText(afterMarker);
  expect(page.url()).toBe(shellUrl);

  await activeTab.hover();
  await activeTab.getByRole('button', { name: 'Close tab' }).click();
  await expect(page.locator(`[data-testid="${tabTestId}"]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-testid="${tabTestId}"]`)).toHaveCount(0);
});
