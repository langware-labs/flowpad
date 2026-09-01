/**
 * Environment variables and FlowPad API-key lifecycle.
 * Source: environment_tab.md
 */
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __flowpadCopiedText?: string;
  }
}

test.describe('Credentials tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (value: string) => {
            window.__flowpadCopiedText = value;
            return Promise.resolve();
          },
          readText: () => Promise.resolve(window.__flowpadCopiedText ?? ''),
        },
      });
    });
  });

  test('API key and project environment lifecycle round-trip', async ({ page }) => {
    await page.goto('/dock/credentials/api-keys');
    await expect(page).toHaveURL(/\/dock\/credentials\/api-keys(?:[/?]|$)/);
    await expect(page.getByRole('heading', { name: 'Credentials' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'API Keys' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('api-keys-view')).toBeVisible();

    await page.getByRole('button', { name: 'Generate FlowPad API Key' }).click();
    const generated = page.locator('textarea[readonly]').first();
    await expect(generated).toBeVisible();
    const rawApiKey = await generated.inputValue();
    expect(rawApiKey).not.toBe('');

    await page.getByRole('button', { name: /Copy( to Clipboard)?$/ }).click();
    expect(await page.evaluate(() => window.__flowpadCopiedText)).toBe(rawApiKey);

    await page.reload();
    await expect(page.getByText('FLOWPAD_API_KEY', { exact: true }).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(rawApiKey);
    await page.getByRole('button', { name: 'Delete API Key' }).click();
    await expect(page.getByRole('button', { name: 'Generate FlowPad API Key' })).toBeVisible();

    await page.goto('/dock/credentials/environment');
    await expect(page).toHaveURL(/\/dock\/credentials\/environment(?:[/?]|$)/);
    await expect(page.getByRole('heading', { name: 'Credentials' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Project Environment' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('project-environment-tab')).toBeVisible();

    await page.getByTestId('env-declare-open').click();
    await page.getByTestId('declare-env-var').fill('TEST2');
    await page.getByTestId('declare-description').fill('QA lifecycle variable');
    await page.getByTestId('declare-value').fill('53');
    await page.getByTestId('declare-submit').click();

    const row = page.getByTestId('env-row-TEST2');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('env-met-TEST2')).toContainText('Met');
    await expect(row).not.toContainText('53');
    await expect(row).toContainText('••••');

    await page.getByTestId('env-provide-open-TEST2').click();
    await page.getByTestId('env-value-input-TEST2').fill('98');
    await page.getByTestId('env-value-save-TEST2').click();
    await expect(page.getByTestId('env-met-TEST2')).toContainText('Met');
    await expect(row).not.toContainText('98');

    await page.getByTestId('env-remove-TEST2').click();
    const unlinkDialog = page.getByRole('alertdialog', { name: 'Stop declaring TEST2?' });
    await unlinkDialog.getByRole('button', { name: 'Stop declaring' }).click();
    await expect(row).toHaveCount(0);
  });
});
