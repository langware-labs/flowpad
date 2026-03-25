/**
 * Regression test: navigating to a shell-X URL with no linked agentic process
 * must load the terminal silently — no redirect, no toast, xterm.js connects.
 *
 * Fix 2026-03-22: shell.startPty() is now called in the loader (plain shell path)
 * after the InteractiveTerminal.tsx effect was removed (TSX = pure UI rule).
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

test('plain shell URL with no linked process loads silently', async ({ page }) => {
  test.setTimeout(120_000);
  const toasts: string[] = [];

  await dismissSetupModal(page);

  // Capture any toast notifications
  page.on('console', msg => {
    if (msg.text().includes('toast') || msg.text().includes('CLI session')) {
      toasts.push(msg.text());
    }
  });

  // Step 1: create a new terminal (plain shell, no Claude started)
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Capture the shell ID — this shell has no linked agentic process
  const shellMatch = page.url().match(/(shell-[\w-]+)/);
  if (!shellMatch) throw new Error('Could not capture shell ID');
  const shellId = shellMatch[1];

  // Step 2: navigate directly to that shell URL
  await page.goto(`/dock/shell/${shellId}`);

  // Step 3: URL must stay on shell- (no redirect to agentic_process-)
  await page.waitForURL(new RegExp(`/dock/shell/${shellId}`), { timeout: 30_000 });
  expect(page.url()).toContain(shellId);
  expect(page.url()).not.toMatch(/agentic_process-/);

  // Step 4: terminal panels must be visible and connected
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });

  // Step 5: no "CLI session not found" toast (removed from plain shell path)
  const toastEl = page.locator('[data-testid="toast"], [role="alert"]').filter({ hasText: 'CLI session' });
  await expect(toastEl).toHaveCount(0);
});
