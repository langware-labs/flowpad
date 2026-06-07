/**
 * ProcessToolbar Fork button — disabled gating + fork creates a sibling.
 * Source: processtoolbar_fork.md
 *
 * Fork is gated on hasTranscript (a real assistant turn). Before the first
 * turn the button is disabled with the tooltip "Send a message first — fork
 * requires conversation history". After a turn it enables and clicking forks
 * a sibling process (new tab, same conversation history).
 *
 * SPEC NOTE: the .md's "plain shell → Fork disabled, tooltip 'Launch a session
 * first'" step does not match the current UI — a plain shell renders NO
 * ProcessToolbar at all (the toolbar mounts only for an AgenticProcess in the
 * Claude pane), so there is no Fork button to inspect on a plain shell. The
 * .md was corrected to assert the toolbar is absent on a plain shell, then the
 * post-launch / pre-turn disabled state with its real tooltip.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, fetchProcess, activePanel } from './_ap_helpers';

const forkBtn = (page: import('@playwright/test').Page) =>
  activePanel(page).locator('button:has(svg.lucide-git-fork)');

test.describe('processtoolbar fork', () => {
  test('test 1: Fork disabled before any assistant turn (no transcript)', async ({ page }) => {
    test.setTimeout(150_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);

    // Plain shell has no ProcessToolbar → no Fork button.
    expect(await page.locator('[data-testid="process-toolbar"]').count()).toBe(0);

    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Toolbar present; Fork disabled (workerStatus still INITIALIZING/IDLE).
    await expect(forkBtn(page)).toBeDisabled();

    // Tooltip reflects the no-transcript gate.
    await forkBtn(page).hover({ force: true });
    await expect(
      page.getByText('Send a message first — fork requires conversation history'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('test 2: Fork enabled after an assistant turn; creates a sibling process', async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Drive a short assistant turn so hasTranscript flips true.
    const panel = activePanel(page);
    await panel.click({ force: true });
    await page.keyboard.type('say hi in one word', { delay: 25 });
    await page.keyboard.press('Enter');

    // Wait for the worker to leave INITIALIZING/IDLE (a turn happened).
    await expect(async () => {
      const proc = await fetchProcess(page, apiBase(), pid);
      const ws = String(proc.worker_status ?? '').toLowerCase();
      expect(['initializing', 'idle', ''].includes(ws)).toBeFalsy();
    }).toPass({ timeout: 120_000 });

    await expect(forkBtn(page)).toBeEnabled({ timeout: 15_000 });

    await forkBtn(page).click();

    // URL navigates to a NEW agentic_process id (the URL was already an
    // agentic_process-, so wait for the id to *change*, not just match).
    await expect(async () => {
      expect(page.url()).toMatch(/agentic_process-[\w-]+/);
      expect(processIdFromUrl(page)).not.toBe(pid);
    }).toPass({ timeout: 30_000 });
    const newPid = processIdFromUrl(page);
    expect(newPid).not.toBe(pid);

    // The fork created a sibling, not a replacement: the original process is
    // still alive on the backend (its tab is still open). Asserting process
    // liveness is robust to tab-strip overflow / cross-repeat tab accumulation,
    // unlike an exact rendered tab count.
    const original = await fetchProcess(page, apiBase(), pid);
    expect(['running', 'stopping', 'idle'].includes(String(original.status))).toBeTruthy();

    const critical = errors.filter(e => !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'));
    expect(critical, critical.join('\n')).toHaveLength(0);
  });
});
