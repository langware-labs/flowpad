/**
 * Environment variables and FlowPad API-key lifecycle.
 * Source: environment_tab.md
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

declare global {
  interface Window {
    __flowpadCopiedText?: string;
  }
}

async function addVariable(
  page: Page,
  name: string,
  value: string,
  type: 'Non Confidential' | 'API Key',
): Promise<Locator> {
  await page.getByRole('button', { name: 'Add Variable' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Environment Variable' });
  await dialog.locator('input[placeholder="VAR_NAME"]').fill(name);
  if (type === 'API Key') {
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: type }).click();
  }
  await dialog.locator('textarea[placeholder="Enter the variable value"]').fill(value);
  await dialog.getByRole('button', { name: 'Save' }).click();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  return row;
}

test.describe('Environment tab', () => {
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

  test('API key plus confidential and non-confidential variables round-trip', async ({ page }) => {
    await page.goto('/dock/environment');
    await expect(page.getByText('Environment Variables', { exact: true })).toBeVisible();

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

    let row = await addVariable(page, 'TEST2', '53', 'Non Confidential');
    await expect(row).toContainText('53');
    await row.getByRole('button').first().click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Environment Variable' });
    await editDialog.locator('textarea[placeholder^="Leave empty"]').fill('98');
    await editDialog.getByRole('button', { name: 'Save' }).click();
    row = page.getByRole('row').filter({ hasText: 'TEST2' });
    await expect(row).toContainText('98');
    await row.getByRole('button').last().click();
    await expect(row).toHaveCount(0);

    row = await addVariable(page, 'TEST2', '123QWE', 'API Key');
    await expect(row).not.toContainText('123QWE');
    await expect(row).toContainText('****');
    await row.getByRole('button').last().click();
    await expect(row).toHaveCount(0);
  });
});
