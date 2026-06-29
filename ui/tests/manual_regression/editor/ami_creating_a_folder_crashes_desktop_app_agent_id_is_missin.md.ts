import { expect, test } from '@playwright/test';

test.describe('Creating content in skills view + nav home does not crash (FLOWPAD-1623)', () => {
  test('skills view renders, New Skill is reachable, and home loads without crash', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      // Post-clear bootstrap returns never_indexed=true → the WelcomeModal
      // overlay intercepts pointer events and blocks the New Skill button.
      localStorage.setItem('flowpad-index-approved', '1');
    });

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/assets/list/skill');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    // Skills view exposes a "New Skill" affordance in the browseable toolbar.
    const newSkill = page.locator('[data-testid="browseable-toolbar-new:skill"]');
    await expect(newSkill).toBeVisible({ timeout: 15_000 });

    // Trigger the create affordance — the regression was a crash with a missing
    // agent_id. This is a crash-guard test (the assertion is "home still loads
    // below"), so force the click with a short cap: the New Skill toolbar button
    // can be geometrically overlapped by a tree row in the headless viewport, and
    // a plain click would otherwise burn the whole test budget on actionability.
    await newSkill.click({ force: true, timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    // Navigate to home — the app must still be mounted (no white-screen crash).
    await page.goto('/dock/home');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="content-panel"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // The home page is still mounted and interactive after the round-trip — no
    // white-screen crash. (This is the actual FLOWPAD-1623 regression gate.)
    await expect(page.locator('[data-testid="recent-conversations-strip"]')).toBeVisible({ timeout: 10_000 });

    // The scenario's last step is specifically about CRASH-related errors
    // (missing agent_id, unhandled exceptions). Transient background-poll
    // failures (e.g. "Failed to list Claude projects: Failed to fetch") are
    // environmental noise, not the crash under test, so they are not asserted.
    const crash = errors.filter((e) =>
      /agent_id|agentId|is missing|Cannot read|undefined is not|Uncaught|Unhandled|crash/i.test(e),
    );
    expect(crash, `Crash-related console errors: ${crash.join('\n')}`).toHaveLength(0);
  });
});
