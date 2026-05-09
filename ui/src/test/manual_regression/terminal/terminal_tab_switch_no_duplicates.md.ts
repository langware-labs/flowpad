import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput, addTerminalTab } from './helpers';

test.describe('Terminal Tab Switch – No Content Duplication', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('switching tabs does not duplicate terminal content', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: Open a fresh terminal
    await gotoShell(page);

    // Capture the session ID from the URL so we can switch back to the exact tab
    const url = page.url();
    const sessionIdMatch = url.match(/\/dock\/shell\/(shell-[A-Za-z0-9_-]+)/);
    expect(sessionIdMatch, 'Could not extract session ID from URL').toBeTruthy();
    const firstSessionId = sessionIdMatch![1];

    // Step 2: Type a unique marker command and wait for output
    await sendCommand(page, 'echo hello_marker');
    await waitForOutput(page, 'hello_marker');

    // Allow output to fully render
    await page.waitForTimeout(1_000);

    // Step 3: Capture terminal content BEFORE tab switch
    const panelSelector = `[data-testid="terminal-panel"][data-session-id="${firstSessionId}"]`;
    const contentBefore = (await page.locator(`${panelSelector} .xterm-rows`).first().textContent()) || '';

    // Count how many times "hello_marker" appears
    const countBefore = (contentBefore.match(/hello_marker/g) || []).length;
    // "hello_marker" should appear exactly twice: once in the command, once in the output
    expect(countBefore, `Expected 2 occurrences before tab switch, got ${countBefore}`).toBe(2);

    // Step 4: Click "+" to open a second terminal tab
    await addTerminalTab(page);

    // Wait for the new terminal to initialise
    await page.waitForTimeout(2_000);

    // Step 5: Switch back to the first terminal tab by its data-testid
    const firstTab = page.locator(`[data-testid="tab-${firstSessionId}"]`);
    await firstTab.click();
    await page.waitForTimeout(1_500);

    // Step 6: Capture terminal content AFTER switching back
    const contentAfter = (await page.locator(`${panelSelector} .xterm-rows`).first().textContent()) || '';

    // Count occurrences after switch
    const countAfter = (contentAfter.match(/hello_marker/g) || []).length;

    // Should still be exactly 2 (command + output), NOT 4 (duplicated)
    expect(
      countAfter,
      `Content was duplicated after tab switch! "hello_marker" appeared ${countAfter} times (expected 2). ` +
        `Content: "${contentAfter.substring(0, 500)}"`,
    ).toBe(2);

    // Additional check: no consecutive duplicate non-empty lines
    const lines = contentAfter
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5);
    const duplicateLines: string[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === lines[i + 1]) {
        duplicateLines.push(lines[i]);
      }
    }
    expect(
      duplicateLines,
      `Found duplicated consecutive lines after tab switch: ${JSON.stringify(duplicateLines)}`,
    ).toHaveLength(0);
  });
});
