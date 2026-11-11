/**
 * Fresh-install configuration navigation must not produce a 500 response.
 * Source: login_with_anthropic_error_500.md
 *
 * The old dedicated "Login with Anthropic" surface no longer exists; provider
 * setup now lives under AI Configuration and Harness Capabilities.
 */
import { expect, test } from '@playwright/test';

test('first configuration visit has no server-error response', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });

  const serverErrors: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/dock/ai-config');
  await expect(page.getByText('AI Configuration', { exact: true })).toBeVisible();
  await expect(page.getByText('FlowPad API Key', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Harnesses' }).click();
  await expect(page.getByText('Capabilities', { exact: true })).toBeVisible();

  expect(serverErrors, `500 responses: ${serverErrors.join(', ')}`).toHaveLength(0);
});
