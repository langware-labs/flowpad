import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal Clear and Scrollback', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('clear command clears screen and terminal remains functional', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell
    await gotoShell(page);

    // Step 2: run several commands to build up history
    await sendCommand(page, 'echo line one');
    await waitForOutput(page, 'line one');

    await sendCommand(page, 'echo line two');
    await waitForOutput(page, 'line two');

    await sendCommand(page, 'echo line three');
    await waitForOutput(page, 'line three');

    // Step 3: run clear command
    await sendCommand(page, 'clear');
    await page.waitForTimeout(1_000);

    // Step 4: validate the visible terminal area no longer shows the old echo outputs
    // After clear, xterm moves old content to scrollback and the visible area shows only the prompt
    const visibleContent = await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .textContent();
    expect(visibleContent).not.toContain('line one');
    expect(visibleContent).not.toContain('line two');

    // Step 5: verify terminal is still functional after clear
    await sendCommand(page, 'echo after clear');
    await waitForOutput(page, 'after clear');
  });
});
