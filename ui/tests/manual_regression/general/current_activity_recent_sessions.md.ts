import { expect, test } from '@playwright/test';

// Since 2026-10-11 the home is always the tabless Vibe hero (docs/viewmodes.md):
// the "current activity" strip and its 3-hour recency filter are gone from the app
// (RecentConversationsStrip renders only in HomeLanding's never-shown Standard
// branch; use-event-driven-sessions was removed). Recent sessions now live in the
// Chats list, whose recency contract is covered by tests/react/chats-open-recency.test.ts.

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  await page.goto('/dock/home');
  await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 90_000 });
}

test.describe('Home — no current-activity strip', () => {
  // ── Test 1: The home is the Vibe hero, without the activity strip ─────────
  test('home is the Vibe hero and shows no current-activity strip', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe', { timeout: 15_000 });
    await expect(page.getByPlaceholder(/would you like to work on/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="recent-conversations-strip"]:visible')).toHaveCount(0);
  });

  // ── Test 2: The home renders without console errors on a fresh load ──────
  test('home renders without console errors on fresh load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await gotoHome(page);
    await expect(page.getByPlaceholder(/would you like to work on/)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2_000);

    const actionableErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('ResizeObserver') &&
        !e.includes('404') &&
        !e.includes('ERR_CONNECTION_REFUSED'),
    );
    expect(actionableErrors, `Console errors: ${actionableErrors.join('\n')}`).toHaveLength(0);
  });
});
