import { test, expect } from '@playwright/test';
import { dismissSetupModal, startClaudeSession } from './helpers';

test.describe('Terminal PTY No Duplicates (Claude CLI)', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('claude CLI terminal has no duplicated lines or escape artifacts', async ({ page }) => {
    test.setTimeout(60_000);

    // Navigate to a new shell, then start a Claude session via the tab-opener menu.
    await page.goto('/dock/shell/new_terminal');
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
    await startClaudeSession(page);

    // Wait for URL to settle (new_terminal redirects to /dock/shell/agentic_process-<id>)
    await page.waitForURL(/\/dock\/shell\/agentic_process-/, { timeout: 60_000 });

    // Wait for terminal to be visible
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for Claude CLI to start and produce output
    // The startup involves: PTY init → send "claude --session-id ..." command → Claude banner
    await page.waitForTimeout(5_000);

    // Read the full terminal text content
    const content =
      (await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first().textContent()) ||
      '';

    // CHECK 1: No raw escape sequence artifacts should be visible
    // ^[[I is a CSI Focus In sequence that should be filtered by the terminal
    // ^[[O is a CSI Focus Out sequence
    // ^[[ is a bare CSI prefix
    // eslint-disable-next-line no-control-regex
    const escapePattern = /\^\[[\u005bA-Za-z]|\x1b\[/;
    const hasEscapeArtifacts = escapePattern.test(content);
    expect(
      hasEscapeArtifacts,
      `Found escape artifacts in terminal output. Content includes: "${content.substring(0, 200)}"`,
    ).toBe(false);

    // CHECK 2: No duplicated consecutive non-empty lines
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

    // CHECK 3: The "claude --session-id" command should appear at most once
    // (the duplicated command is a known bug in the start-claude flow)
    const claudeCommandMatches = content.match(/claude --session-id/g) || [];
    expect(
      claudeCommandMatches.length,
      `"claude --session-id" appeared ${claudeCommandMatches.length} times (expected at most 1). PTY input is being sent/echoed multiple times.`,
    ).toBeLessThanOrEqual(1);
  });
});
