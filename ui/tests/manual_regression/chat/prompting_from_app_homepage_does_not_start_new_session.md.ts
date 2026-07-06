/**
 * Typing and submitting from the app home page navigates to a working session
 * (FLOWPAD-1656). Source: prompting_from_app_homepage_does_not_start_new_session.md
 *
 * CONTRACT UPDATE: home submit is now intentionally routed to the VIBE WORKSPACE
 * (HomeLanding.handleSessionSubmit → handleVibeSubmit), which seeds a HEADLESS
 * project-Chat process rather than the old PTY `createAndStartSession` shell.
 * See HomeLanding.tsx:182-187 for the documented rationale (the old PTY path
 * couldn't host the vibe chat, so the prompt never ran). So the landing surface
 * is the vibe creator ("New build" / "Build history"), NOT a raw terminal panel.
 * The invariant under test is unchanged: submitting from home NAVIGATES to a
 * real, working session (it does not stay on home or spawn a dead session).
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding } from './helpers';

test.describe('home prompt navigates to a session', () => {
  test('test 1: submit from home → vibe workspace session view', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoLanding(page);

    // submitFromLanding dismisses any lingering WelcomeModal (which can intercept
    // the Enter keypress on the home input) before filling + submitting, and
    // waits for the /dock/shell/ navigation.
    await submitFromLanding(page, 'hi');
    expect(page.url()).toContain('/dock/shell/');

    // The vibe workspace (creator surface) is now mounted — its build-session
    // toolbar (the "New build" control, testid entity-execution-new) is the
    // stable, view-mode-independent signal that home submit opened the seeded
    // chat session. Multiple entity-execution toolbars mount (inactive panels
    // keep a hidden copy), so scope to the visible one.
    await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible({ timeout: 30_000 });
  });
});
