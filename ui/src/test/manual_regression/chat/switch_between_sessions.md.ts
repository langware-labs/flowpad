import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, ensureActiveSession, sendInstruction } from './helpers';

test.describe('Switch Between Sessions', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('create multiple session tabs and switch between them', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'session switch test');
    await ensureActiveSession(page);

    // send a message in session 1
    await sendInstruction(page, 'I am session one');
    await expect(page.getByText('I am session one')).toBeVisible();
    const sessionAUrl = page.url();

    // click "+" to add a new session tab
    await page.getByTestId('add-session-tab-button').click();

    // wait for URL to change to a different session
    await page.waitForURL(
      (url) => {
        return url.pathname.startsWith('/dock/session/') && url.href !== sessionAUrl;
      },
      { timeout: 10_000 },
    );

    // wait for the new session to load
    const instructionInput = page.getByPlaceholder('instruction...');
    await instructionInput.waitFor({ state: 'visible', timeout: 10_000 });

    // validate the new session has a different URL
    const sessionBUrl = page.url();
    expect(sessionBUrl).not.toBe(sessionAUrl);
    expect(sessionBUrl).toMatch(/\/dock\/session\/[\w-]+/);

    // validate there are now two session tabs
    const sessionTabs = page.locator('[data-testid^="session-tab-"]');
    await expect(sessionTabs).toHaveCount(2, { timeout: 5_000 });

    // click first tab to switch back
    await sessionTabs.first().click();
    await page.waitForTimeout(500);

    // validate URL changed back to session A
    expect(page.url()).toBe(sessionAUrl);
  });
});
