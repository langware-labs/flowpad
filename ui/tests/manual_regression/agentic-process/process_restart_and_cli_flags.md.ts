/**
 * ProcessToolbar Restart + CLI flag persistence + restart-required glow + gating.
 * Source: process_restart_and_cli_flags.md
 *
 * Gating model (ProcessToolbar.tsx):
 *   started      = process.status === RUNNING  → gates Restart + CLI toggles
 *   hasTranscript= real assistant turn         → gates Fork + Open Transcript
 * CLI flag toggles persist straight to the entity on change; the backend save
 * hook flips process.restart_required when the worker-relevant snapshot drifts
 * from last_started_hash, lighting the Restart button (data-restart-required).
 * Restart is the only path back to a clean snapshot.
 *
 * NOTE: pty_pid renders as "none (detached)" for these sessions, so the .md's
 * "pty_pid is different" check is not observable in the UI. The respawn is
 * instead proven by the restart-required glow clearing after a Restart click
 * (test 2/3) — that flag only resets on a real respawn.
 */
import { test, expect, type Page } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, activePanel, fetchProcess } from './_ap_helpers';

const restart = (page: Page) => activePanel(page).locator('[data-testid="process-toolbar-restart"]');
const cliOptions = (page: Page) => activePanel(page).locator('button[aria-label="CLI Options"]');

test.describe('process restart and CLI flags', () => {
  test('test 1: Restart button respawns the PTY (clean, no console errors)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Restart is enabled while RUNNING.
    await expect(restart(page)).toBeEnabled();
    await restart(page).click();

    // After restart the session returns to RUNNING and the button is enabled again.
    await waitForRunningSession(page, apiBase(), pid);
    await expect(restart(page)).toBeEnabled({ timeout: 30_000 });
    // xterm still mounted/attached (banner re-renders into the same panel).
    await expect(page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first()).toBeAttached();

    const critical = errors.filter(e => !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'));
    expect(critical, critical.join('\n')).toHaveLength(0);
  });

  test('test 2: toggling a CLI flag persists + lights the Restart glow; Restart clears it', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Baseline: not glowing.
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'false');

    // Toggle Chrome ON.
    await cliOptions(page).click();
    await page.getByRole('menuitemcheckbox', { name: /Chrome browser/ }).click();
    await page.keyboard.press('Escape');

    // Persisted to the entity on toggle (no separate Apply step). Poll the
    // backend rather than re-driving the Radix menu (which races on re-open).
    await expect(async () => {
      const proc = await fetchProcess(page, apiBase(), pid);
      expect(proc.cli_config?.chrome).toBe(true);
    }).toPass({ timeout: 10_000 });

    // Restart now flagged as required (glow).
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'true', { timeout: 10_000 });

    // Click Restart → respawn → glow clears.
    await restart(page).click();
    await waitForRunningSession(page, apiBase(), pid);
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'false', { timeout: 30_000 });
  });

  test('test 3: out-of-band entity mutation lights the glow; only a Restart clears it', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'false');

    // Mutate cli_config.chrome=true out-of-band on the cached entity + save.
    // (Chrome defaults OFF, so this is a real drift from last_started_hash;
    // Debug defaults ON for these sessions, which would be a no-op mutation.)
    await page.evaluate(async (id) => {
      const dm = (window as any).dataManager;
      let p: any;
      for (const [tid, ref] of dm.entities) {
        if (tid.type === 'agentic_process' && (ref.entity?.id === id || String(tid).includes(id))) { p = ref.entity; break; }
      }
      if (!p) throw new Error('process entity not in cache');
      p.cli_config = { ...(p.cli_config ?? {}), chrome: true };
      await p.save();
    }, pid);

    // Glow appears.
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'true', { timeout: 10_000 });

    // Toggle Chrome OFF again in the dropdown — glow STILL on (snapshot still
    // drifted from last_started_hash; only a real restart clears it).
    await cliOptions(page).click();
    await page.getByRole('menuitemcheckbox', { name: /Chrome browser/ }).click();
    await page.keyboard.press('Escape');
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'true');

    // Restart clears the glow.
    await restart(page).click();
    await waitForRunningSession(page, apiBase(), pid);
    await expect(restart(page)).toHaveAttribute('data-restart-required', 'false', { timeout: 30_000 });
  });

  test('test 4: ProcessToolbar gating (no toolbar on plain shell; gated buttons once running)', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);

    // Plain shell: no ProcessToolbar at all.
    expect(await page.locator('[data-testid="process-toolbar"]').count()).toBe(0);

    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    // Toolbar now present in the active panel; Restart ENABLED (started=true).
    await expect(activePanel(page).locator('[data-testid="process-toolbar"]')).toBeVisible();
    await expect(restart(page)).toBeEnabled();

    // Fork DISABLED — no assistant turn yet (hasTranscript=false).
    const fork = activePanel(page).locator(`button:has(svg.lucide-git-fork)`);
    await expect(fork).toBeDisabled();

    // Open Transcript DISABLED — no transcript yet.
    const transcript = activePanel(page).locator(`button:has(svg.lucide-scroll-text)`);
    await expect(transcript).toBeDisabled();

    // CLI Options checkboxes ENABLED (started unlocks toggles).
    await cliOptions(page).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /Chrome browser/ })).toBeEnabled();
    await expect(page.getByRole('menuitemcheckbox', { name: /Full Trust/ })).toBeEnabled();
    await expect(page.getByRole('menuitemcheckbox', { name: /Debug logging/ })).toBeEnabled();
    await page.keyboard.press('Escape');
  });
});
