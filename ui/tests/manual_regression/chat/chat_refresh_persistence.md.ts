import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';
import { gotoShell } from '../terminal/helpers';

test.describe('Chat Refresh Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Shell session tab persists after page refresh', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: Navigate to new_terminal and wait for shell to be ready
    await gotoShell(page);

    // Step 2: Note the current URL (contains /dock/shell/<session-id>)
    const shellUrl = page.url();
    expect(shellUrl).toMatch(/\/dock\/shell\/shell-/);

    // Step 3: Validate terminal is visible before refresh
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();

    // Step 4: Navigate to the same URL again (simulating refresh)
    await page.goto(shellUrl);

    // Step 5: Validate terminal is visible after refresh
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible({ timeout: 30_000 });

    // Step 6: Validate the session tab is shown in the tab bar
    const shellId = new URL(shellUrl).pathname.split('/').pop()!;
    const sessionTab = page.locator(`[data-testid="tab-shell|${shellId}"]`);
    await expect(sessionTab).toBeVisible({ timeout: 15_000 });
  });
});
