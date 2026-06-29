import { type Page, expect } from '@playwright/test';

/** Kept for older manual tests; the desktop setup modal no longer exists. */
export async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => {});
}

/** Navigate to landing and wait for it to fully load. */
export async function gotoLanding(page: Page) {
  // The home landing is at /dock/home (root / redirects to FlowPage which loads home)
  await page.goto('/dock/home');
  // Handle WelcomeModal ("Set up Flowpad" / "Welcome to Flowpad!") which appears
  // after a DB reset when scanInfo.never_indexed=true. Bootstrap can take 5–10s on a
  // fresh DB, so use a 12s timeout to ensure the modal is caught before we wait for the heading.
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 12_000 }).catch(() => false)) {
    await skipForNow.click({ force: true, timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await waitForLanding(page);
}

/** Wait for the landing page to fully load. */
export async function waitForLanding(page: Page) {
  // Use a CSS/text selector instead of getByRole — when WelcomeModal (an AlertDialog) is open,
  // Radix UI sets aria-hidden="true" on the rest of the page, causing getByRole('heading') to
  // fail even though the heading is visible in the DOM behind the overlay.
  // Increased to 90s to handle slow AgentLayout initialization after multiple prior tests.
  await page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first().waitFor({ state: 'visible', timeout: 90_000 });
}

/**
 * Type a message in the landing-page session input and press Enter.
 * The new landing page uses TerminalLineSessionInput which navigates to /dock/shell/<uuid>.
 *
 * NOTE: The old chat session model was replaced with a terminal-based shell model.
 * submitFromLanding now navigates to the shell terminal.
 */
export async function submitFromLanding(page: Page, message: string) {
  // Dismiss WelcomeModal if it's still blocking (AlertDialog sets aria-hidden on the page).
  // This can happen if the DB was just reset and bootstrap returned never_indexed=true,
  // or if gotoLanding's 12s wait didn't catch it in time.
  // Use force:true because the modal may be animating / re-rendering when we try to click.
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await skipForNow.click({ force: true, timeout: 5_000 }).catch(() => {});
    // Give modal time to close
    await page.waitForTimeout(800);
  }
  // Home renders <SessionInput> inline as a textarea with
  // aria-label="What would you like to work on?". Use a CSS attribute selector
  // to avoid getByRole aria-hidden issues when modals are still resolving.
  const input = page.locator('textarea[aria-label="What would you like to work on?"]');
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(message);
  await input.press('Enter');
  // Wait for navigation to shell terminal page
  await page.waitForURL(/\/dock\/shell\//, { timeout: 30_000 });
}

/**
 * Wait for the shell terminal to be ready after navigating from landing.
 * The old ensureActiveSession / sendInstruction / waitForDone helpers targeted
 * the old chat UI which no longer exists.
 *
 * This is a placeholder that waits for the shell tab to appear.
 */
export async function ensureShellReady(page: Page) {
  // Wait for the active terminal panel + xterm to render.
  await page.locator('[data-testid="terminal-panel"][data-active="true"]').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm').first().waitFor({
    state: 'attached',
    timeout: 15_000,
  });
}

/**
 * @deprecated The old chat session model no longer exists.
 * Use ensureShellReady() instead.
 */
export async function ensureActiveSession(page: Page) {
  await ensureShellReady(page);
}

/**
 * @deprecated sendInstruction targeted the old chat UI.
 * The new session model uses a shell terminal (xterm.js PTY).
 */
export async function sendInstruction(page: Page, message: string) {
  // Type into the terminal (best effort)
  const terminal = page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-screen').first();
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
