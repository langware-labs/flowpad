/**
 * Regression test: process with visible=false is still recovered when navigating to its shell URL.
 *
 * Root cause (fixed 2026-03-22): loadShell queried only visible=true processes.
 * A process with visible=false was invisible to the loader → no redirect to agentic_process URL
 * → CurrentProcessTypeId set to null → session lost.
 *
 * Fix: query all processes (no visible filter); shell path redirects to linkedProcess URL unconditionally.
 *
 * Note: the agentic process has its own dedicated PTY shell (shell_id on the process entity),
 * separate from the user's original interactive shell. We navigate to the process's shell URL.
 */
import { test, expect } from '@playwright/test';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test('agentic process with visible=false is recovered when navigating to shell URL', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  await dismissSetupModal(page);

  // Step 1: navigate to new terminal
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Step 2: start Claude via the always-present "+" tab-opener menu.
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-claude"]').click();
  await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 30_000 });

  const processUrlMatch = page.url().match(/agentic_process-([\w-]+)/);
  if (!processUrlMatch) throw new Error('Could not capture process ID');
  const processId = processUrlMatch[1];

  // Step 3: fetch the process's own shell_id
  const shellId = await page.evaluate(
    async ({ id }) => {
      const res = await fetch(`http://localhost:9008/api/v1/graph/agentic_process/${id}`);
      const json = await res.json();
      return json?.data?.shell_id as string | null;
    },
    { id: processId },
  );
  if (!shellId) throw new Error(`Process ${processId} has no shell_id`);

  // Step 4: set visible=false via API (simulates the bug scenario)
  const patchRes = await page.evaluate(
    async ({ id }) => {
      const res = await fetch(`http://localhost:9008/api/v1/graph/agentic_process/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible: false }),
      });
      return res.status;
    },
    { id: processId },
  );
  expect(patchRes).toBe(200);

  // Step 5: navigate directly to the process's shell URL
  await page.goto(`/dock/shell/shell-${shellId}`);

  // Step 6: loader must redirect to agentic_process URL (process recovered despite visible=false)
  await page.waitForURL(/\/dock\/shell\/agentic_process-/, { timeout: 30_000 });
  expect(page.url()).toContain(processId);

  // Step 7: terminal is live
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });

  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
