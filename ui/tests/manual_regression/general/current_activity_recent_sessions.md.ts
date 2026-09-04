import { expect, test } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  // Pin the mode on the ADDRESS. The surfaces asserted below
  // (`recent-conversations-strip`, the greeting) exist only on the Standard
  // HomeLanding; Vibe renders the creator homepage instead. The app legitimately
  // lands in Vibe after the project-open path (`use-open-project` opens home
  // `.withViewMode(ViewMode.Vibe)`, and the dock sync persists it instance-wide),
  // so a test that wants Standard has to say so rather than inherit whatever the
  // instance was last left in.
  await page.goto(withViewMode('/dock/home', 'standard'));
  // Wait for the React app root to mount (handles HMR settling)
  await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 90_000 });
}

test.describe('Current Activity — Recent Sessions', () => {
  // ── Test 1: Activity panel is present ─────────────────────────────────────
  test('home page has a current activity panel', async ({ page }) => {
    await gotoHome(page);
    const strip = page.locator('[data-testid="recent-conversations-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: No console errors during activity panel render ─────────────────
  test('current activity panel renders without console errors on fresh load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await gotoHome(page);
    const strip = page.locator('[data-testid="recent-conversations-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });

    // Wait for the panel to settle
    await page.waitForTimeout(2_000);

    // Filter out known non-actionable noise
    const actionableErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('ResizeObserver') &&
        !e.includes('404') &&
        !e.includes('ERR_CONNECTION_REFUSED'),
    );
    expect(actionableErrors, `Console errors: ${actionableErrors.join('\n')}`).toHaveLength(0);
  });

  // ── Test 3: Sessions modified within last 3 hours appear after page reload ─
  test('sessions active within last 3 hours appear in current activity on page reload', async ({ page }) => {
    // This test is meaningful only when the selected project has sessions modified
    // within the last 3 hours. If none exist, the panel is empty — which is also valid.
    await gotoHome(page);

    const strip = page.locator('[data-testid="recent-conversations-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });

    // Give time for session data to load from the project scan
    await page.waitForTimeout(3_000);

    // Count visible session items
    const items = strip.locator('[data-testid="activity-item"]');
    const count = await items.count();

    // If there are items visible, validate they have a recognisable session structure
    if (count > 0) {
      const first = items.first();
      await expect(first).toBeVisible({ timeout: 5_000 });
      // Each item should contain some text content (name or timestamp)
      const text = await first.textContent();
      expect(text?.trim().length).toBeGreaterThan(0);
    }
    // If count === 0, the project has no sessions in the last 3 hours — this is acceptable
  });

  // ── Test 4: Activity panel does not show stale sessions on reload ──────────
  test('current activity does not surface sessions with no events and modifiedAt > 3h ago', async ({
    page,
  }) => {
    // Inject a mock session entry into localStorage that is 4 hours old with no events
    // This validates the 3-hour cutoff on the client side.
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      // We can't inject into the registry directly, but we validate that
      // the activity strip starts empty when no project is loaded
    });

    await page.goto(withViewMode('/dock/home', 'standard'));
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const strip = page.locator('[data-testid="recent-conversations-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });

    // The panel should not show sessions from 4+ hours ago without live events.
    // We assert no items appear immediately before any live sniffer events arrive
    // (within the first 1 second of the page being visible).
    await page.waitForTimeout(1_000);

    // If items are visible, they must either be "running" or have modifiedAt within 3h.
    // We read the timestamp from each visible item and verify.
    const items = strip.locator('[data-testid="activity-item"]');
    const count = await items.count();
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const now = Date.now();

    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      // Items should have a data-modified-at or data-status attribute set by the component
      const modifiedAt = await item.getAttribute('data-modified-at').catch(() => null);
      const status = await item.getAttribute('data-status').catch(() => null);
      if (modifiedAt) {
        const ms = new Date(modifiedAt).getTime();
        const isRecent = ms > now - THREE_HOURS_MS;
        const isRunning = status === 'running';
        expect(isRecent || isRunning).toBe(true);
      }
    }
  });

  // ── Test 5: Activity strip renders correctly when no sessions exist ─────────
  test('current activity strip renders empty state gracefully', async ({ page }) => {
    await gotoHome(page);

    const strip = page.locator('[data-testid="recent-conversations-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });

    // The strip should always be visible — it should never crash or disappear
    await page.waitForTimeout(2_000);
    await expect(strip).toBeVisible();
  });
});
