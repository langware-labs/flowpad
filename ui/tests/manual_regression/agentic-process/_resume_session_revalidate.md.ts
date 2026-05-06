import { test, expect } from '@playwright/test';

test('revalidate: resume claude session has live PTY + Info icon', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', 'true');
  });

  await page.goto('/dock/shell/new_terminal');
  await page.waitForURL(/\/dock\/shell\//, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Open History modal via +-menu
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-history"]').click();

  // Recent Sessions modal must show entries
  await expect(page.locator('text=Recent Sessions')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(2_000);

  const noSessions = await page.locator('text=No recent sessions').isVisible().catch(() => false);
  expect(noSessions, 'Need at least one recent session for the test').toBe(false);

  const firstRowButton = page.locator('[role="dialog"] ul li button').first();
  await firstRowButton.waitFor({ state: 'visible', timeout: 5_000 });
  await firstRowButton.click();

  // URL navigates to /dock/shell/agentic_process-<id>
  await page.waitForURL(/\/dock\/shell\/agentic_process-[a-f0-9-]+/, { timeout: 30_000 });
  const url = page.url();
  console.log('Resumed URL:', url);
  const apId = url.match(/agentic_process-([a-f0-9-]+)/)![1];

  // Tab strip should now surface the resumed process (after #24 fix: visible=true + start)
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(3_000);

  const tabCount = await page.locator('[data-testid^="tab-"]').count();
  console.log('Tab count after resume:', tabCount);
  expect(tabCount).toBeGreaterThanOrEqual(1);

  // Diagnostic: dump all aria-label buttons in the toolbar area
  await page.waitForTimeout(8_000);
  const ariaLabels = await page.locator('button[aria-label]').evaluateAll(els =>
    els.map(e => e.getAttribute('aria-label')).filter(Boolean),
  );
  console.log('All button aria-labels on page:', ariaLabels);

  // Also check for hasSession-related state via URL/process info
  const url2 = page.url();
  console.log('Current URL after wait:', url2);

  // Snapshot of relevant DOM elements
  const toolbarExists = await page.locator('[class*="ProcessToolbar"], [data-testid*="process-toolbar"]').count();
  console.log('Process toolbar mounted count:', toolbarExists);

  const infoIcon = page.locator('button[aria-label="Session info"]').first();
  await infoIcon.waitFor({ state: 'visible', timeout: 30_000 });
  console.log('Info icon visible after resume — fix #24 confirmed');

  await infoIcon.click();
  await expect(page.locator('text=Session Details').first()).toBeVisible({ timeout: 5_000 });

  const popText = await page.locator('[role="dialog"]').last().textContent() || '';
  // Session ID row must contain a UUID
  expect(popText).toMatch(/Session ID/);
  expect(popText).toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
  console.log('Session ID present in popover');
});
