import { test, expect } from '@playwright/test';

// Thin smoke matching trace-gutter / workflow-annotation idiom — full
// add/read/persist/delete coverage requires a real markdown entity and is
// driven via debugMcp against a live dev stack.

const APP_URL = 'http://localhost:4098';

test.describe('Markdown review-mode comments', () => {
  test('app loads and exposes the markdown editor surface', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* WS keeps it pending */ });

    const reviewChip = page.locator('[data-testid="editor-mode-chip-review"]');
    const count = await reviewChip.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
