/**
 * PowerShell shell startup regression (FLOWPAD-1614).
 * Source: shell_slow_to_start_powershell_only.md
 */
import { expect, test } from '@playwright/test';

test('PowerShell shell opens and renders its prompt within the normal test deadline', async ({ page }) => {
  test.skip(process.platform !== 'win32', 'wrong-platform: FLOWPAD-1614 is PowerShell-only');
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('viewMode', 'advanced');
  });

  await page.goto('/dock/shell/new_terminal');

  await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
  const rows = page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first();
  await expect(rows).toBeAttached();
  const rendered = (await rows.textContent()) ?? '';
  expect(rendered.trim().length).toBeGreaterThan(0);
  expect(rendered).toMatch(/PS|PowerShell|>/i);
});
