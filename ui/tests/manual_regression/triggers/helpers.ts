import { type Page } from '@playwright/test';
import { apiOrigin } from '../_shared/api';

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
 * Open one automation's Runs tab (or the Automations list when no id is given).
 */
export async function gotoAutomation(page: Page, triggerId?: string) {
  await page.goto(triggerId ? `/dock/automations?trigger=${triggerId}&tab=runs` : '/dock/automations');

  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  await page
    .getByTestId(triggerId ? 'automation-page' : 'automations-list')
    .waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Delete all schedule triggers created during tests by calling the API directly.
 */
export async function cleanupScheduleTriggers(page: Page, triggerIds: string[]) {
  void page;
  const api = apiOrigin();
  for (const id of triggerIds) {
    await fetch(`${api}/api/v1/graph/trigger/${id}`, { method: 'DELETE' });
  }
}
