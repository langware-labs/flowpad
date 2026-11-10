import { test, expect } from '@playwright/test';

test.describe('project Git-coupled invite', () => {
  test('project home shows the invite control and gates invite actions through scoped GitHub test', async ({ page }) => {
    const capabilityTests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/graph/capabilities/test')) capabilityTests.push(request.url());
    });

    await page.goto('/dock/assets/project-home');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    const settings = page.getByRole('dialog', { name: 'Assistants & keys' });
    if (await settings.count()) await settings.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('project-home-members')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('members-invite-button')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('members-invite-button').click();
    await expect(page.getByTestId('members-avatar-stack')).toBeVisible();
    const link = page.getByTestId('members-invite-link');
    if (await link.count()) {
      await link.click();
      await expect.poll(() => capabilityTests.length).toBeGreaterThan(0);
    }
  });
});
