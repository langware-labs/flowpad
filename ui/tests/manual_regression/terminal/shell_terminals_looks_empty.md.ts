/**
 * Shell Terminals looks empty (FLOWPAD-1608).
 * Source: shell_terminals_looks_empty.md
 *
 * Open terminals, navigate Home (client-side), then back to Shell (client-side).
 * The terminal panels must show their PTY content — not render blank. The
 * regression is empty/blank terminals after a no-reload nav round-trip.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab, goHome, gotoShellView, sendCommand, waitForOutput, activePanel } from './helpers';

test.describe('Shell terminals looks empty', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 1: terminals show content after Home -> Shell round-trip', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to app (shell), opening the default terminal.
    await gotoShell(page);

    // Step 2: open extra terminals (siblings in the strip) and run marker
    // commands. Opening a terminal is URL-first: the new tab becomes the active
    // panel, and `addTerminalTab` now returns only once that new terminal is the
    // settled active+ready panel — so each marker lands in the terminal just
    // opened. Capture WHICH session the markers landed in from the active panel's
    // data-session-id rather than assuming it follows the URL.
    await addTerminalTab(page);
    await sendCommand(page, 'echo qa-marker-one');
    await waitForOutput(page, 'qa-marker-one');
    await addTerminalTab(page);
    await sendCommand(page, 'echo qa-marker-two');
    await waitForOutput(page, 'qa-marker-two');
    const markerSid = await activePanel(page).getAttribute('data-session-id');
    expect(markerSid, 'active terminal session id where markers landed').toBeTruthy();

    // Step 3: navigate Home (client-side React Router nav, no reload).
    await goHome(page);

    // Step 4: click Shell to return (client-side nav). The bare shell restore is
    // project-scoped, so on a fresh db it may surface an empty terminal from the
    // default (empty) project rather than the marker terminal — that is expected
    // and NOT what this scenario guards.
    await gotoShellView(page);

    // Step 5: the marker terminal's tab is still in the strip. Click it
    // (client-side, no reload) — its PTY content must be RESTORED, not a blank
    // surface (FLOWPAD-1608). This is the actual regression: xterm rows replay
    // the previously-typed output after a no-reload nav round-trip.
    await page.locator(`[data-testid="tab-shell|${markerSid}"]`).click();
    const restored = page.locator(`[data-testid="terminal-panel"][data-session-id="${markerSid}"]`);
    await expect(restored).toBeVisible({ timeout: 15_000 });
    await expect(restored.locator('.xterm-rows').first()).toBeAttached({ timeout: 15_000 });

    // The restored terminal's content is non-empty (PTY replay restored it)...
    await expect
      .poll(
        async () => {
          const txt = (await restored.locator('.xterm-rows').first().textContent()) ?? '';
          return txt.trim().length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // ...and still shows its marker output (not blank).
    await waitForOutput(page, 'qa-marker-two');
  });
});
