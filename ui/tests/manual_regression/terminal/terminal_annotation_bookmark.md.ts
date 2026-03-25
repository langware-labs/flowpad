import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

const EXISTING_PROCESS_URL = '/dock/shell/agentic_process-0938e838-d3b8-4c6c-8883-3be42d6b3522';
const EXISTING_PROCESS_ID = 'agentic_process-0938e838-d3b8-4c6c-8883-3be42d6b3522';

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
    test.setTimeout(120_000);

    await page.goto(EXISTING_PROCESS_URL);
    await page.waitForURL(new RegExp(EXISTING_PROCESS_ID), { timeout: 60_000 });

    // Wait for terminal panels
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Annotation gutter must be present for an agentic process with worker_session_id
    const gutter = page.locator('[data-testid="annotation-gutter"]');
    await expect(gutter).toBeAttached({ timeout: 10_000 });
  });

  test('test 4+5: Create bookmark and verify Open Session navigates to correct process', async ({ page }) => {
    test.setTimeout(180_000);

    // ── Step 1: Navigate to the existing agentic process ──────────────────────
    await page.goto(EXISTING_PROCESS_URL);
    await page.waitForURL(new RegExp(EXISTING_PROCESS_ID), { timeout: 60_000 });
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Wait for annotation gutter
    const gutter = page.locator('[data-testid="annotation-gutter"]');
    await expect(gutter).toBeAttached({ timeout: 10_000 });

    // ── Step 2: Click first "+" button in annotation gutter ───────────────────
    // Gutter buttons are aria-haspopup="dialog" divs (opacity-0, need force:true)
    // Index 0 may be an existing bookmark icon — use the last one to get a fresh line
    const gutterTriggers = gutter.locator('[aria-haspopup="dialog"]');
    const triggerCount = await gutterTriggers.count();
    // Click the last trigger (most likely a fresh "+" with no bookmark yet)
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
    expect(page.url()).toContain(EXISTING_PROCESS_ID);

    // Brief wait for bookmark to be persisted to backend
    await page.waitForTimeout(1_500);

    // ── Step 6: Navigate home ─────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    // ── Step 7: Find and click "Open Session" on the bookmark card ────────────
    const openSessionBtn = page.getByRole('button', { name: /open session/i }).first();
    await expect(openSessionBtn).toBeVisible({ timeout: 15_000 });
    await openSessionBtn.click();

    // ── Step 8: Verify navigation goes to the CORRECT existing process ────────
    // Must contain the same process ID (0938e838), NOT a new one
    await page.waitForURL(new RegExp(EXISTING_PROCESS_ID), { timeout: 30_000 });
    expect(page.url()).toContain(EXISTING_PROCESS_ID);

    // Must include ?t= timestamp parameter
    expect(page.url()).toContain('?t=');
  });
});
