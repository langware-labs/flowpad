/**
 * Open Terminal button opens a plain shell in the process workdir.
 * Source: open_shell_from_process_workdir.md
 *
 * The SquareTerminal icon (tooltip "Open terminal in <workdir>") in the
 * non-embedded ProcessToolbar calls navigation.openNewShell({ cwd: workdir }),
 * which creates a Shell with workdir = the process workdir and navigates to it.
 *
 * Robustness notes: the shell prompt only shows the dir *basename*, and typing
 * into the xterm to run `pwd` is timing-fragile, so the workdir is verified via
 * the new Shell entity's `workdir` field (the source of truth) rather than xterm
 * text. New-tab creation is verified by the URL switching to a fresh shell-<uuid>
 * (exact accumulated tab counts are not asserted).
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, fetchProcess, activePanel } from './_ap_helpers';

async function fetchShellWorkdir(page: import('@playwright/test').Page, shellId: string): Promise<string | null> {
  return page.evaluate(async ({ base, id }) => {
    const res = await fetch(`${base}/api/v1/graph/shell/${id}`);
    const json = await res.json();
    return (json?.data?.workdir as string) ?? null;
  }, { base: apiBase(), id: shellId });
}

test.describe('open shell from process workdir', () => {
  test('test 1: Open Terminal opens a new plain shell in the process workdir', async ({ page }) => {
    test.setTimeout(150_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);
    const proc = await fetchProcess(page, apiBase(), pid);
    const workdir: string = proc.workdir;
    expect(workdir).toBeTruthy();

    // SquareTerminal "Open terminal in <workdir>".
    const openTerminal = activePanel(page).locator('button:has(svg.lucide-square-terminal)');
    await expect(openTerminal).toBeVisible();
    await openTerminal.click();

    // A NEW plain shell tab opens (URL is shell-<uuid>, not agentic_process-).
    await page.waitForURL(/\/dock\/shell\/shell-[\w-]+/, { timeout: 15_000 });
    const shellId = page.url().match(/shell-([\w-]+)/)![1];

    // The new shell's workdir equals the process workdir (source of truth: the
    // Shell entity, populated from openNewShell({ cwd: workdir })).
    await expect(async () => {
      expect(await fetchShellWorkdir(page, shellId)).toBe(workdir);
    }).toPass({ timeout: 10_000 });

    // The new shell renders an interactive xterm whose prompt carries the
    // workdir basename.
    await expect(page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first()).toBeAttached();
    const base = workdir.split('/').filter(Boolean).pop()!;
    await expect(async () => {
      const txt = await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first().textContent();
      expect(txt).toContain(base);
    }).toPass({ timeout: 15_000 });

    // The original Claude tab is still present alongside the new plain shell —
    // every tab (Shell or AgenticProcess) carries a `tab-shell-` testid, so two
    // tabs now exist.
    expect(await page.locator('[data-testid^="tab-shell-"]').count()).toBeGreaterThanOrEqual(2);
  });

  test('test 2: Open Terminal available without a Claude session (default cwd shell)', async ({ page }) => {
    test.setTimeout(150_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // The non-embedded ProcessToolbar always renders the Open Terminal button.
    const openTerminal = activePanel(page).locator('button:has(svg.lucide-square-terminal)');
    await expect(openTerminal).toBeVisible();
    const urlBefore = page.url();
    await openTerminal.click();

    // Switches to a fresh plain shell (different URL).
    await page.waitForURL(/\/dock\/shell\/shell-[\w-]+/, { timeout: 15_000 });
    expect(page.url()).not.toBe(urlBefore);
    const shellId = page.url().match(/shell-([\w-]+)/)![1];

    // Sensible default cwd: the new shell has a non-empty absolute workdir.
    await expect(async () => {
      const wd = await fetchShellWorkdir(page, shellId);
      expect(wd && wd.startsWith('/')).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  });
});
