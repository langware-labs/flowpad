import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

const APP_URL = process.env.APP_URL ?? 'http://localhost:4098';

/**
 * Navigate to an agentic process terminal with worker_session_id set.
 * Creates one via "Start Claude" if needed. Returns the process URL.
 */
async function gotoAgenticProcessWithSession(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

  if (!page.url().includes('agentic_process-')) {
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    const startBtn = page.locator('[data-testid="start-claude-button"]');
    await startBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await startBtn.click();
    await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 60_000 });
  }

  // Wait for the process ribbon (indicates worker_session_id is set)
  const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
  const ribbon = activePanel.locator('.border-t .ml-auto');
  await expect(ribbon).toBeVisible({ timeout: 60_000 });

  return page.url();
}

test.describe('terminal_annotation_bookmark', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 2: Annotation gutter is not visible in a plain shell terminal', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/dock/shell/new_terminal');
    await page.waitForURL(/\/dock\/shell\/(shell-)/, { timeout: 60_000 });

    // Wait for terminal to be ready (aria-label has lowercase 'i' in 'input')
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('textarea[aria-label="Terminal input"]').first()).toBeVisible({ timeout: 10_000 });

    // Annotation gutter must NOT be present in a plain shell
    const gutter = page.locator('[data-testid="annotation-gutter"]');
    await expect(gutter).not.toBeAttached({ timeout: 3_000 });
  });

  test('test 3: Annotation gutter is visible for existing agentic process with worker session ID', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoAgenticProcessWithSession(page);

    // Annotation gutter must be present for an agentic process with worker_session_id
    const gutter = page.locator('[data-testid="annotation-gutter"]');
    await expect(gutter).toBeAttached({ timeout: 10_000 });
  });

  test('test 4+5: Create bookmark and verify Open Session navigates to correct process', async ({ page }) => {
    test.setTimeout(240_000);

    // Navigate to an agentic process and capture its ID
    const processUrl = await gotoAgenticProcessWithSession(page);
    const processIdMatch = processUrl.match(/agentic_process-[a-f0-9-]+/);
    if (!processIdMatch) {
      test.skip(true, 'Could not determine agentic process ID from URL');
      return;
    }
    const processId = processIdMatch[0];

    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Wait for annotation gutter
    const gutter = page.locator('[data-testid="annotation-gutter"]');
    await expect(gutter).toBeAttached({ timeout: 10_000 });

    // ── Step 2: Click first "+" button in annotation gutter ───────────────────
    const gutterTriggers = gutter.locator('[aria-haspopup="dialog"]');
    const plusBtn = gutterTriggers.last();
    await plusBtn.click({ force: true });

    // ── Step 3: Select "Bookmark" from the annotation type picker ─────────────
    const popover = page.locator('[data-radix-popper-content-wrapper]');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    const bookmarkBtn = popover.getByText('Bookmark').first();
    await expect(bookmarkBtn).toBeVisible({ timeout: 3_000 });
    await bookmarkBtn.click();

    // ── Step 4: Fill bookmark textarea ─────────────────────────────────────────
    const textarea = page.locator('textarea[placeholder="Type a note..."]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('e2e test bookmark');

    // ── Step 5: Save the bookmark ──────────────────────────────────────────────
    const saveBtn = popover.getByRole('button', { name: 'Save' });
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });
    await saveBtn.click();

    // URL must stay on the same process (no redirect away)
    expect(page.url()).toContain(processId);

    // Brief wait for bookmark to be persisted to backend
    await page.waitForTimeout(1_500);

    // ── Step 6: Navigate to home landing page ────────────────────────────────
    // Use /dock/home explicitly — navigating to '/' can redirect to the active
    // agentic process shell, bypassing the home page bookmark column entirely.
    await page.goto('/dock/home');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    // Dismiss WelcomeModal if it appears (shows after DB reset when never_indexed=true)
    const skipForNow = page.getByRole('button', { name: 'Skip for now' });
    if (await skipForNow.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await skipForNow.click();
      await page.waitForTimeout(500);
    }

    // ── Step 7: Find and click "Open Session" on the bookmark card ────────────
    const openSessionBtn = page.getByRole('button', { name: /open session/i }).first();
    await expect(openSessionBtn).toBeVisible({ timeout: 15_000 });
    await openSessionBtn.click();

    // ── Step 8: Verify navigation goes to the CORRECT existing process ────────
    await page.waitForURL(new RegExp(processId), { timeout: 30_000 });
    expect(page.url()).toContain(processId);

    // Must include ?t= timestamp parameter
    expect(page.url()).toContain('?t=');
  });
});
