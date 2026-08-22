/**
 * Regression: Quick Create -> Claude Code must finish on the created process's
 * canonical dock URL after the router loader materializes its tab.
 *
 * This is intentionally browser-backed. It uses the real app, real router, and
 * real backend; no SDK mocks and no Playwright route interception. The failure
 * being captured is an address-bar ordering bug, so a memory-router/jsdom test
 * cannot reproduce it faithfully.
 *
 * This directory's Playwright config intentionally discovers `*.md.ts` tests.
 */
import { expect, test } from '@playwright/test';
import { AP_QUICK_CREATE_LABEL, dismissSetupModal } from './_ap_helpers';
import { withViewMode } from '../_shared/view-mode';

function processIdFromCreateResponse(payload: unknown): string {
  const candidate = payload as { data?: { id?: unknown }; id?: unknown };
  const id = candidate.data?.id ?? candidate.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Could not read created process id from response: ${JSON.stringify(payload)}`);
  }
  return id;
}

test('Quick Create Claude session commits its final browser URL after dock loading', async ({ page }) => {
  await dismissSetupModal(page);

  await page.goto(withViewMode('/dock/home', 'advanced'));
  await expect(page.getByRole('button', { name: 'Quick create' })).toBeVisible();

  const createProcessResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/v1/graph/compute_node/') &&
      response.url().includes('/createProcess') &&
      response.status() === 200,
  );

  const tabMaterializedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/v1/graph/tab/new_tab') &&
      response.status() === 200,
  );

  await page.getByRole('button', { name: 'Quick create' }).click();
  await expect(page.getByRole('dialog', { name: 'Create new' })).toBeVisible();
  await page.getByRole('button', { name: AP_QUICK_CREATE_LABEL }).click();

  const createdProcess = processIdFromCreateResponse(await (await createProcessResponse).json());
  await tabMaterializedResponse;

  const expectedPath = `/dock/shell/agentic_process-${createdProcess}`;
  await expect(page).toHaveURL(new RegExp(`${expectedPath}(?:\\?|$)`));
  await expect(page.getByTestId(`tab-shell|agentic_process-${createdProcess}`)).toBeVisible();
});
