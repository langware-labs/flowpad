import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand } from '../terminal/helpers';

test.describe('Chat Input Controls', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Shell terminal input accepts text and executes on Enter', async ({ page }) => {
    test.setTimeout(150_000);

    // Capture console errors from the start
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await gotoShell(page);
    await sendCommand(page, 'echo shell_input_test_enter');
    await page.waitForTimeout(2000);

    // Terminal should still be visible (no crash)
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();

    // Filter out known-acceptable errors
    const realErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('favicon'),
    );
    expect(realErrors, `Console errors: ${realErrors.join(', ')}`).toHaveLength(0);
  });

  test('Empty Enter press does not crash terminal', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoShell(page);

    const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await terminalPanel.click({ force: true });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
  });

  test('Tab opener menu exposes Claude and Terminal rows', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoShell(page);

    // The "+" plus button is the always-present tab-opener affordance.
    // Inline opener buttons (opener-inline-claude, open-terminal-tab-button)
    // only render once the user has pinned that opener.
    const plus = page.getByTestId('opener-plus-button');
    await expect(plus).toBeVisible({ timeout: 5_000 });
    await plus.click();
    await expect(page.getByTestId('opener-menu-row-claude')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('opener-menu-row-terminal')).toBeVisible({ timeout: 5_000 });
  });
});
