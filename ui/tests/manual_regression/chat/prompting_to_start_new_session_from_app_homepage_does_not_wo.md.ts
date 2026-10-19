/**
 * FLOWPAD-1653 — submitting "hi" from Home creates a real headless chat
 * process and navigates to its workspace.
 */
import { expect, test } from '@playwright/test';
import { apiBase } from '../_shared/api';
import { gotoLanding, submitFromLanding } from './helpers';

test('home prompt starts a usable headless chat session', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  await gotoLanding(page, 'vibe');

  await submitFromLanding(page, 'hi');
  const processId = page.url().match(/agentic_process-([0-9a-f-]{36})/)?.[1];
  expect(processId).toBeTruthy();
  await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();

  const response = await page.request.get(`${apiBase()}/api/v1/graph/agentic_process/${processId}`);
  expect(response.status()).toBe(200);
  const process = (await response.json())?.data;
  expect(process.id).toBe(processId);
  expect(process.process_type).toBe('chat');
  expect(process.pty_mode).toBe(false);
  expect(process.visible).toBe(false);
});
