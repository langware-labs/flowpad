/**
 * Typing and submitting from the app home page navigates to a shell session
 * (FLOWPAD-1656). Source: prompting_from_app_homepage_does_not_start_new_session.md
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding } from './helpers';

test.describe('home prompt navigates to shell', () => {
  test('test 1: submit from home → shell session view', async ({ page }) => {
    test.setTimeout(120_000);
    await dismissSetupModal(page);
    await gotoLanding(page);

    // submitFromLanding dismisses any lingering WelcomeModal (which can intercept
    // the Enter keypress on the home input) before filling + submitting, and
    // waits for the /dock/shell/ navigation.
    await submitFromLanding(page, 'hi');
    expect(page.url()).toContain('/dock/shell/');

    // Terminal view is now visible.
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible({ timeout: 30_000 });
  });
});
