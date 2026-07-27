/**
 * Observability surfaces — PTY Viewer (Columns & Trace dropdown) + Open Transcript.
 * Source: observability_surfaces.md
 *
 * test 1: PTY Viewer is available to all users (no dev-mode gate) from the
 *         Columns & Trace (BugPlay) dropdown; opens a modal showing the raw
 *         PTY stream; closes cleanly.
 * test 2: Open Transcript navigates to the claude transcript lens once a turn
 *         exists. The button is gated on hasTranscript (a real assistant turn),
 *         so we send a one-word prompt and wait for it to enable.
 * test 3: Open Transcript icon is gated on hasSession (renders only after a
 *         session exists).
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, activePanel, waitForAssistantTurnOrSkip } from './_ap_helpers';

test.describe('observability surfaces', () => {
  test('test 1: PTY Viewer opens from Columns & Trace dropdown (no dev gate)', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Open the Columns & Trace (BugPlay) dropdown.
    await activePanel(page).locator('button[aria-label="Columns & Trace"]').click();
    const ptyItem = page.getByRole('menuitem', { name: 'PTY Viewer' });
    await expect(ptyItem).toBeVisible();
    await ptyItem.click();

    // Modal mounts with the "PTY Viewer" title and raw-stream stats.
    const dialog = page.getByRole('dialog').filter({ hasText: 'PTY Viewer' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Raw-stream stats line. Was "Replay: ..." until the replay buffer was
    // removed (4466d9bc) — the summary now reports xterm memory chunks.
    await expect(dialog.getByText(/xterm memory:/)).toBeVisible({ timeout: 15_000 });

    // Close (Esc) → modal unmounts, terminal view unaffected.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first()).toBeAttached();
  });

  test('test 2: Open Transcript navigates to the claude transcript lens', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    const transcriptBtn = activePanel(page).locator('button:has(svg.lucide-scroll-text)');
    await expect(transcriptBtn).toBeVisible();

    // Drive a real (short) assistant turn so hasTranscript flips true and the
    // button enables. Type into the active xterm panel.
    const panel = activePanel(page);
    await panel.click({ force: true });
    await page.keyboard.type('say hi in one word', { delay: 25 });
    await page.keyboard.press('Enter');

    // Wait for the worker to leave INITIALIZING/IDLE (assistant turn happened),
    // or conditionally skip when the live-Claude turn can't land on this host.
    await waitForAssistantTurnOrSkip(page, apiBase(), pid);

    await expect(transcriptBtn).toBeEnabled({ timeout: 15_000 });
    await transcriptBtn.click();

    // URL navigates to the transcript lens for this session.
    await page.waitForURL(/\/dock\/lens\/claude\/transcript\//, { timeout: 15_000 });
  });

  test('test 3: Open Transcript icon is hidden until a session exists', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);

    // Plain shell, no session → no ProcessToolbar, hence no ScrollText icon.
    expect(await page.locator('button:has(svg.lucide-scroll-text)').count()).toBe(0);

    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Now rendered (hasSession=true), even though disabled until a turn exists.
    await expect(activePanel(page).locator('button:has(svg.lucide-scroll-text)')).toBeVisible({ timeout: 15_000 });
  });
});
