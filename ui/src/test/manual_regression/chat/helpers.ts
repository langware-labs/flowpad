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
  await page.goto('/');
  // Handle setup modal if it appears despite localStorage suppression
  const skipButton = page.getByRole('button', { name: 'Skip' });
  if (await skipButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skipButton.click();
  }
  await waitForLanding(page);
}

/** Wait for the landing page to fully load. */
export async function waitForLanding(page: Page) {
  await page.getByRole('heading', { name: /hey /i }).waitFor({ state: 'visible', timeout: 15_000 });
}

/** Type a message in the landing-page input and press Enter to create a session. */
export async function submitFromLanding(page: Page, message: string) {
  const input = page.getByRole('textbox', { name: 'What would you like to work on?' });
  await input.waitFor({ state: 'visible' });
  await input.fill(message);
  await input.press('Enter');
  // Wait for navigation to session page (generous timeout for slow backends)
  await page.waitForURL(/\/dock\/session\//, { timeout: 30_000 });
}

/** Click "New Session" if the session page shows "No active session". */
export async function ensureActiveSession(page: Page) {
  const noSession = page.getByText('No active session');
  if (await noSession.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
  }
  // Wait for the instruction input to appear
  await page.getByPlaceholder('instruction...').waitFor({ state: 'visible', timeout: 10_000 });
}

/** Send an instruction in the session view and wait for the response. */
export async function sendInstruction(page: Page, message: string) {
  const input = page.getByPlaceholder('instruction...');
  await input.waitFor({ state: 'visible' });
  // Ensure any previous execution is complete before sending
  await waitForDone(page);
  const countBefore = await page.locator('text=◂ assistant').count();
  await input.fill(message);
  await input.press('Enter');
  // Wait for a new assistant response block (avoids race with stale DONE status)
  await expect(page.locator('text=◂ assistant')).toHaveCount(countBefore + 1, { timeout: 45_000 });
}

/** Wait until the status bar shows "DONE". */
export async function waitForDone(page: Page, timeout = 45_000) {
  await expect(page.getByText('DONE', { exact: true })).toBeVisible({ timeout });
}

/** Navigate to the home / landing page via the sidebar Home button. */
export async function goHome(page: Page) {
  // The sidebar renders as ul > li > button; Home is the first button in the list
  await page.locator('ul li button').first().click();
  await page.waitForURL(/^\/$|\/$/, { timeout: 10_000 });
  await waitForLanding(page);
}

/** Create a brand-new session from the landing page and send a first message. */
export async function createSessionWithMessage(page: Page, message: string) {
  await submitFromLanding(page, message);
  await ensureActiveSession(page);
  await sendInstruction(page, message);
}
