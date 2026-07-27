/**
 * AI/LLM configuration remains reachable from a fresh application.
 * Source: LLM_comfigure.md
 *
 * The v0.28 provider-number/OAuth modal was replaced by the AI Configuration
 * view. This guards the surviving configuration contract: API keys and local
 * harness capabilities are both reachable without crashing.
 */
import { expect, test } from '@playwright/test';

test.describe('AI configuration', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('fresh app exposes API-key and harness configuration', async ({ page }) => {
    await page.goto('/dock/ai-config');

    await expect(page.getByText('AI Configuration', { exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'LLM APIs' })).toBeVisible();
    await expect(page.getByText('FlowPad API Key', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Harnesses' }).click();

    await expect(page).toHaveURL(/\/dock\/ai-config\/clis$/);
    await expect(page.getByText('Capabilities', { exact: true })).toBeVisible();
  });
});
