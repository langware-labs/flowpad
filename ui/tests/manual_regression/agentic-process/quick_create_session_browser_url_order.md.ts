/**
 * Regression: Quick Create -> Claude Code must update the visible browser URL
 * before target-loader side effects run.
 *
 * This is intentionally browser-backed. It uses the real app, real router, and
 * real backend; no SDK mocks and no Playwright route interception. The failure
 * being captured is an address-bar ordering bug, so a memory-router/jsdom test
 * cannot reproduce it faithfully.
 *
 * This directory's Playwright config intentionally discovers `*.md.ts` tests.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal } from './_ap_helpers';

function processIdFromCreateResponse(payload: unknown): string {
  const candidate = payload as { data?: { id?: unknown }; id?: unknown };
  const id = candidate.data?.id ?? candidate.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Could not read created process id from response: ${JSON.stringify(payload)}`);
  }
  return id;
}

test('Quick Create Claude session commits browser URL before dock loader mutates tabs', async ({ page }) => {
  await dismissSetupModal(page);

  await page.goto('/');
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
  await page.getByRole('button', { name: 'Claude Code' }).click();

  const createdProcess = processIdFromCreateResponse(await (await createProcessResponse).json());
  await tabMaterializedResponse;

  const expectedPath = `/dock/shell/agentic_process-${createdProcess}`;
  const actualPathAtTabMaterialization = new URL(page.url()).pathname;

  expect(actualPathAtTabMaterialization).toBe(expectedPath);
  await expect(page.getByTestId(`tab-shell|agentic_process-${createdProcess}`)).toBeVisible();
});
