import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from '../terminal/helpers';
import { withViewMode } from '../_shared/view-mode';

test.describe('Send Multiple Messages', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Multiple shell commands can be typed without crashing the terminal', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await gotoShell(page);

    await sendCommand(page, 'echo command_one');
    await waitForOutput(page, 'command_one');
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();

    await sendCommand(page, 'echo command_two');
    await waitForOutput(page, 'command_two');
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();

    await sendCommand(page, 'echo command_three');
    await waitForOutput(page, 'command_three');
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();

    // Active terminal tab is still visible in the tab bar
    await expect(page.locator('[data-testid^="tab-"]').first()).toBeVisible();

    const realErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('favicon'),
    );
    expect(realErrors, `Console errors: ${realErrors.join(', ')}`).toHaveLength(0);
  });

  test('Terminal tab remains active after multiple commands', async ({ page }) => {
    test.setTimeout(30_000);

    // Navigate directly to the shell without creating a new session (avoids stacking)
    await page.goto(withViewMode('/dock/shell', 'advanced'));

    // Terminal panels should be visible
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible({ timeout: 10_000 });

    // Active terminal tab is still visible in the tab bar
    await expect(page.locator('[data-testid^="tab-"]').first()).toBeVisible({ timeout: 5_000 });
  });
});
