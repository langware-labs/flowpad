/**
 * Submitting from the home page opens a new shell session (FLOWPAD-1672).
 * Source: new_session_is_not_opened.md
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding } from './helpers';

test.describe('home submit opens a shell session', () => {
  test('test 1: submitting from home opens a new shell session', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoLanding(page);

    // submitFromLanding dismisses any lingering WelcomeModal before fill+submit
    // and waits for the /dock/shell/ navigation.
    await submitFromLanding(page, 'hi');
    expect(page.url()).toContain('/dock/shell/');
  });
});
