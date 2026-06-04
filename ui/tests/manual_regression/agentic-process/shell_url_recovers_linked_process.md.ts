/**
 * Regression test: navigating to shell-X URL when an agentic process is linked
 * must redirect to the agentic_process URL and show the live session.
 *
 * Fix 2026-03-22: loadShell shell path now redirects to linkedProcess.dockPointer URL
 * unconditionally (no status check). Previously only active processes were redirected,
 * leaving invisible/non-visible processes unrecovered.
 *
 * Note: the agentic process has its own dedicated PTY shell (shell_id on the process entity),
 * separate from the user's original interactive shell. We must navigate to the process's
 * own shell URL to trigger the redirect.
 */
import { test, expect } from '@playwright/test';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// Cold-nav redirect now works: routePlainShellPointer resolves the owning
// process by shell_id via the backend (AgenticProcess.getByShellId →
// terminals/get_by_shell_id) when the in-memory cache is cold, so the redirect
// fires on a fresh page.goto. (Fix per Debug #17.)
test('navigating to shell URL with linked agentic process redirects to agentic_process URL', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  await dismissSetupModal(page);

  // Step 1: go to a new terminal
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Step 2: start Claude → URL moves to agentic_process-
  // Use the always-present "+" tab opener menu; the inline Claude button only
  // renders once that opener has been pinned (default pinned list is empty).
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-claude"]').click();
  await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 30_000 });

  const processMatch = page.url().match(/agentic_process-([\w-]+)/);
  if (!processMatch) throw new Error('Could not capture agentic_process ID from URL');
  const processId = processMatch[1];

  // Step 3: fetch the process entity to get its own shell_id
  // (the process has a dedicated PTY shell, separate from the user's interactive shell)
  const shellId = await page.evaluate(
    async ({ id }) => {
      const res = await fetch(`http://localhost:9008/api/v1/graph/agentic_process/${id}`);
      const json = await res.json();
      return json?.data?.shell_id as string | null;
    },
    { id: processId },
  );
  if (!shellId) throw new Error(`Process ${processId} has no shell_id`);

  // Step 4: navigate directly to the process's shell URL
  await page.goto(`/dock/shell/shell-${shellId}`);

  // Step 5: loader must redirect back to the agentic_process URL
  await page.waitForURL(/\/dock\/shell\/agentic_process-/, { timeout: 30_000 });
  expect(page.url()).toContain(processId);

  // Step 6: terminal is live
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });

  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
