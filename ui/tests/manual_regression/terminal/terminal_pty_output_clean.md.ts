import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal PTY Output Clean', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('no duplicated lines or escape sequence artifacts in terminal output', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to a fresh terminal
    await gotoShell(page);

    // Step 2: run two marker commands
    await sendCommand(page, 'echo MARKER_START');
    await waitForOutput(page, 'MARKER_START');

    await sendCommand(page, 'echo MARKER_END');
    await waitForOutput(page, 'MARKER_END');

    // Step 3: read the full terminal text content
    const content =
      (await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first().textContent()) ||
      '';

    // Step 4: check for raw escape sequence artifacts
    // These should NEVER appear as visible text in the terminal:
    // ^[ (ESC), ^[[I (focus in), ^[[O (focus out), ^[[ (CSI prefix)
    const escapeArtifacts = content.match(/\^?\[[\u005bA-Za-z]/g);
    expect(escapeArtifacts, `Found escape artifacts in terminal: ${JSON.stringify(escapeArtifacts)}`).toBeNull();

    // Step 5: check for duplicated consecutive lines
    // Split content into lines, filter out empty/whitespace-only lines
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5);
    const duplicates: string[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === lines[i + 1]) {
        duplicates.push(lines[i]);
      }
    }
    expect(duplicates, `Found duplicated consecutive lines: ${JSON.stringify(duplicates)}`).toHaveLength(0);
  });
});
