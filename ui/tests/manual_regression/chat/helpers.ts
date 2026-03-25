import { type Page, expect } from '@playwright/test';

/**
 * Dismiss the DesktopSetupModal if it appears.
 * The modal shows on first load when localStorage key 'llm-setup-modal-seen' is not set.
 * We set it before navigating so it never appears, and also try to dismiss if it still does.
 */
export async function dismissSetupModal(page: Page) {
  // Pre-set localStorage to suppress the modal before page loads
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

/** Navigate to landing and wait for it to fully load. */
export async function gotoLanding(page: Page) {
  // The home landing is at /dock/home (root / redirects to FlowPage which loads home)
  await page.goto('/dock/home');
  // Handle setup modal if it appears despite localStorage suppression
  const skipButton = page.getByRole('button', { name: 'Skip' });
  if (await skipButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skipButton.click();
  }
  await waitForLanding(page);
}

/** Wait for the landing page to fully load. */
export async function waitForLanding(page: Page) {
  // Increased to 90s to handle slow AgentLayout initialization after multiple prior tests
  // and accumulated shell entities from prior test runs slowing the backend.
  await page.getByRole('heading', { name: /hey /i }).waitFor({ state: 'visible', timeout: 90_000 });
}

/**
 * Type a message in the landing-page session input and press Enter.
 * The new landing page uses TerminalLineSessionInput which navigates to /dock/shell/<uuid>.
 *
 * NOTE: The old chat session model (/dock/session/) was replaced with a terminal-based
 * shell model (/dock/shell/). submitFromLanding now navigates to the shell terminal.
 */
export async function submitFromLanding(page: Page, message: string) {
  // New UI: TerminalLineSessionInput is hidden behind a button by default.
  // Click the "What would you like to work on today?" button to reveal the input first.
  const triggerBtn = page.getByRole('button', { name: /what would you like to work on today\?/i });
  if (await triggerBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await triggerBtn.click();
  }
  // Now the input[aria-label="Start new Claude Code session..."] should be visible
  const input = page.getByRole('textbox', { name: 'Start new Claude Code session...' });
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(message);
  await input.press('Enter');
  // Wait for navigation to shell terminal page
  await page.waitForURL(/\/dock\/shell\//, { timeout: 30_000 });
}

/**
 * Wait for the shell terminal to be ready after navigating from landing.
 * The old ensureActiveSession / sendInstruction / waitForDone helpers targeted
 * the /dock/session/ chat UI which no longer exists.
 *
 * This is a placeholder that waits for the shell tab to appear.
 */
export async function ensureShellReady(page: Page) {
  // Wait for the terminal panel to appear
  await page.locator('[data-terminal-id], .xterm-screen, .xterm').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });
}

/**
 * @deprecated The old chat session model (/dock/session/) no longer exists.
 * Use ensureShellReady() instead.
 */
export async function ensureActiveSession(page: Page) {
  await ensureShellReady(page);
}

/**
 * @deprecated sendInstruction targeted the old /dock/session/ chat UI.
 * The new session model uses a shell terminal (xterm.js PTY).
 */
export async function sendInstruction(page: Page, message: string) {
  // Type into the terminal (best effort)
  const terminal = page.locator('.xterm-screen, [data-terminal-id]').first();
  await terminal.click({ timeout: 5_000 }).catch(() => {});
  await page.keyboard.type(message);
  await page.keyboard.press('Enter');
}

/** @deprecated The old chat status bar (DONE) no longer exists in the shell terminal model. */
export async function waitForDone(page: Page, _timeout = 45_000) {
  // The shell terminal doesn't have a DONE status indicator
  // Wait a fixed amount of time as fallback
  await page.waitForTimeout(3_000);
}

/** Navigate to the home / landing page. */
export async function goHome(page: Page) {
  // Navigate directly to the home dock view
  await page.goto('/dock/home');
  await waitForLanding(page);
}

/** Create a brand-new session from the landing page. */
export async function createSessionWithMessage(page: Page, message: string) {
  await submitFromLanding(page, message);
  await ensureShellReady(page);
}
