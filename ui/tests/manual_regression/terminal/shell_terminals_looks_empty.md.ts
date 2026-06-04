/**
 * Shell Terminals looks empty (FLOWPAD-1608).
 * Source: shell_terminals_looks_empty.md
 *
 * Open terminals, navigate Home (client-side), then back to Shell (client-side).
 * The terminal panels must show their PTY content — not render blank. The
 * regression is empty/blank terminals after a no-reload nav round-trip.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab, goHome, gotoShellView, sendCommand, waitForOutput } from './helpers';

test.describe('Shell terminals looks empty', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 1: terminals show content after Home -> Shell round-trip', async ({ page }) => {
    test.setTimeout(150_000);

    // Step 1: navigate to app (shell), opening the default terminal.
    await gotoShell(page);

    // Step 2: open 2 terminals and run a command in each so they have content.
    await addTerminalTab(page);
    await sendCommand(page, 'echo qa-marker-one');
    await waitForOutput(page, 'qa-marker-one');
    await addTerminalTab(page);
    await sendCommand(page, 'echo qa-marker-two');
    await waitForOutput(page, 'qa-marker-two');

    // Step 3: navigate Home (client-side React Router nav, no reload).
    await goHome(page);

    // Step 4: click Shell to return (client-side nav).
    await gotoShellView(page);

    // Step 5: terminals should show content — the active panel renders xterm
    // rows with the previously-typed marker, not a blank surface.
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await expect(activePanel).toBeVisible({ timeout: 15_000 });
    await expect(activePanel.locator('.xterm-rows').first()).toBeAttached({ timeout: 15_000 });

    // The active terminal's content is non-empty (PTY replay restored it).
    await expect
      .poll(
        async () => {
          const txt = (await activePanel.locator('.xterm-rows').first().textContent()) ?? '';
          return txt.trim().length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // The most-recently-active terminal still shows its marker output.
    await waitForOutput(page, 'qa-marker-two');
  });
});
