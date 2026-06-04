/**
 * Switch between multiple shell terminal tabs.
 * Source: switch_between_sessions.md
 *
 * The active tab carries the `border-primary` class (TabbedTerminal.tsx:1002).
 * Tabs are addressed by their `tab-shell-<key>` testid.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';
import { gotoShell, addTerminalTab } from '../terminal/helpers';

test.describe('switch between sessions', () => {
  test('test 1: switching between two terminal tabs flips the active tab, no console errors', async ({ page }) => {
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await dismissSetupModal(page);
    await gotoShell(page);

    // First tab present.
    const firstId = page.url().match(/(shell-[\w-]+)/)?.[1];
    expect(firstId).toBeTruthy();
    const firstTab = page.locator(`[data-testid="tab-${firstId}"]`);
    await expect(firstTab).toBeVisible({ timeout: 15_000 });

    // Open a second tab.
    const tabsBefore = await page.locator('[data-testid^="tab-shell-"]').count();
    await addTerminalTab(page);
    await expect(page.locator('[data-testid^="tab-shell-"]')).toHaveCount(tabsBefore + 1, { timeout: 15_000 });

    // The newly-opened tab id (the one that is NOT firstId).
    const ids = await page.locator('[data-testid^="tab-shell-"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.replace(/^tab-/, '')),
    );
    const secondId = ids.find((id) => id !== firstId);
    expect(secondId).toBeTruthy();
    const secondTab = page.locator(`[data-testid="tab-${secondId}"]`);

    // Click the first tab → it becomes active (border-primary).
    await firstTab.click();
    await expect(firstTab).toHaveClass(/border-primary/, { timeout: 10_000 });

    // Click the second tab → it becomes active.
    await secondTab.click();
    await expect(secondTab).toHaveClass(/border-primary/, { timeout: 10_000 });

    const critical = consoleErrors.filter((e) =>
      !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
    );
    expect(critical, critical.join('\n')).toHaveLength(0);
  });
});
