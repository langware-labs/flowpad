import { expect, test } from '@playwright/test';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  // The home has no view mode of its own: the loader canonicalizes any `viewMode`
  // address to the plain home, which shows the Vibe landing. The old Standard
  // landing (with the `recent-conversations-strip`) is still mounted but hidden
  // behind the Vibe branch, so it can never be the surface a person sees.
  await page.goto('/dock/home');
  // Wait for the React app root to mount (handles HMR settling)
  await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 90_000 });
}

// What a person sees on Home is the Vibe landing: the greeting and the prompt box.
const landing = (page: import('@playwright/test').Page) => page.locator('h1:visible').first();
const prompt = (page: import('@playwright/test').Page) => page.locator('textarea:visible').first();

test.describe('Home landing — what is on screen after load', () => {
  test('home page shows the landing greeting and the prompt box', async ({ page }) => {
    await gotoHome(page);
    await expect(landing(page)).toBeVisible({ timeout: 10_000 });
    await expect(prompt(page)).toBeVisible({ timeout: 10_000 });
  });

  test('home landing renders without console errors on fresh load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await gotoHome(page);
    await expect(landing(page)).toBeVisible({ timeout: 10_000 });

    // Wait for the page to settle
    await page.waitForTimeout(2_000);

    // Filter out known non-actionable noise
    const actionableErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('ResizeObserver') &&
        !e.includes('404') &&
        !e.includes('ERR_CONNECTION_REFUSED'),
    );
    expect(actionableErrors, `Console errors: ${actionableErrors.join('\n')}`).toHaveLength(0);
  });

  test('home landing is still there after a reload', async ({ page }) => {
    await gotoHome(page);
    await expect(landing(page)).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 90_000 });
    await expect(landing(page)).toBeVisible({ timeout: 10_000 });
    await expect(prompt(page)).toBeVisible({ timeout: 10_000 });
  });
});
