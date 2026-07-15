import { type Page } from '@playwright/test';

/**
 * Dismiss the DesktopSetupModal if it appears.
 */
export async function dismissSetupModal(page: Page) {
  // Pre-set localStorage to suppress the LLM setup modal before the page loads.
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

/**
 * Navigate to the Triggers view and wait for the trigger list to appear.
 */
export async function gotoTriggers(page: Page) {
  await page.goto('/dock/triggers');

  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  // Wait for the trigger list container
  await page.locator('text=Triggers').first().waitFor({ state: 'visible', timeout: 30_000 });
  // Wait for the left panel to settle
  await page.waitForTimeout(1_000);
}

/**
 * Delete all schedule triggers created during tests by calling the API directly.
 */
export async function cleanupScheduleTriggers(page: Page, triggerIds: string[]) {
  for (const id of triggerIds) {
    await page.evaluate(async (triggerId) => {
      // Relative URL: same-origin in-page fetch, proxied by Vite to the app's backend.
      await fetch(`/api/v1/graph/trigger/${triggerId}`, {
        method: 'DELETE',
      });
    }, id);
  }
}
