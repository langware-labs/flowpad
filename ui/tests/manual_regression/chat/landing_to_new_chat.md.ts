import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding } from './helpers';

test.describe('Landing to New Chat', () => {
  test.describe.configure({ retries: 1 });

  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('start new session from landing page navigates to shell terminal', async ({ page }) => {
    test.setTimeout(180_000);

    // Step 1: navigate to landing page and validate it
    await gotoLanding(page);
    await expect(page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first()).toBeVisible();
    // Wait for page to settle before interacting
    await page.waitForLoadState('networkidle').catch(() => {});

    // Step 2: submit from landing page to create session
    // New UI: TerminalLineSessionInput with aria-label="Start new Claude Code session..."
    // Navigates to /dock/shell/<uuid> instead of old /dock/session/<uuid>
    await submitFromLanding(page, 'Hello, can you help me?');

    // Step 3: validate URL changed to /dock/shell/<uuid>
    await expect(page).toHaveURL(/\/dock\/shell\//, { timeout: 15_000 });

    // Step 4: validate terminal tab bar is visible
    const terminalArea = page.locator('.xterm, .xterm-screen, [class*="terminal"]').first();
    await expect(terminalArea).toBeVisible({ timeout: 15_000 });
  });
});
