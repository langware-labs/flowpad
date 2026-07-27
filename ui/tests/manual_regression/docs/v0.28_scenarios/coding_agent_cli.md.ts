/**
 * Start a coding-agent CLI from the terminal tab opener.
 * Source: coding_agent_cli.md
 */
import { expect, test } from '@playwright/test';

test.describe('Coding-agent CLI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('viewMode', 'advanced');
    });
  });

  test('Claude opener creates a visible interactive process tab', async ({ page }) => {
    await page.goto('/dock/shell/new_terminal');
    await expect(page).toHaveURL(/\/dock\/shell\/(shell-|agentic_process-)/);
    await expect(page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first()).toBeAttached();

    await page.getByTestId('opener-plus-button').click();
    await page.getByTestId('opener-menu-row-claude').click();

    await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-(?!new)[\w-]+$/);
    const processPointer = page.url().split('/dock/shell/').pop();
    expect(processPointer).toMatch(/^agentic_process-[\w-]+$/);
    await expect(
      page.locator(
        `[data-testid="terminal-panel"][data-active="true"][data-session-id="${processPointer}"] .xterm-rows`,
      ),
    ).toBeAttached();
  });
});
