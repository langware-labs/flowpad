/**
 * Closing a shell terminal tab does not produce a 401 console error (FLOWPAD-1642).
 * Source: closing_a_chat_produces_console_error_401.md
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';
import { gotoShell } from '../terminal/helpers';

test.describe('closing a chat — no 401', () => {
  test('test 1: closing a terminal tab produces no 401 console error', async ({ page }) => {
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await dismissSetupModal(page);
    await gotoShell(page);

    // At least one terminal tab is present.
    const tabs = page.locator('[data-testid^="tab-shell-"]');
    await expect(tabs.first()).toBeVisible({ timeout: 15_000 });

    // Close the active tab via its X (aria-label="Close tab").
    const closeBtn = page.getByRole('button', { name: 'Close tab' }).first();
    await expect(closeBtn).toBeVisible({ timeout: 10_000 });
    await closeBtn.click();
    await page.waitForTimeout(2_000);

    // No 401 unauthorized errors in the console.
    const unauthorized = consoleErrors.filter((e) => /\b401\b|unauthorized/i.test(e));
    expect(unauthorized, unauthorized.join('\n')).toHaveLength(0);
  });
});
