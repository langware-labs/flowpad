import { expect, test } from '@playwright/test';

test.describe('Creating content in skills view + nav home does not crash (FLOWPAD-1623)', () => {
  test('skills view renders, New Skill is reachable, and home loads without crash', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/assets/list/skill');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    // The list-level New action remains available even when the scoped Skill
    // tree root is hidden because its count is zero.
    const newSkill = page.locator('[data-testid="content-panel"] button[title="New"]');
    await expect(newSkill).toBeVisible({ timeout: 15_000 });

    // Trigger the real create affordance — the regression was a crash while
    // opening this flow with a missing agent_id.
    await newSkill.click();
    await expect(page.getByRole('dialog').getByText('New skill', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // Navigate to home — the app must still be mounted (no white-screen crash).
    await page.goto('/dock/home');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="content-panel"]')).toBeVisible({ timeout: 15_000 });

    // The home page is still mounted and interactive after the round-trip — no
    // white-screen crash. (This is the actual FLOWPAD-1623 regression gate.)
    await expect(page.locator('[data-testid="recent-conversations-strip"]')).toBeVisible({ timeout: 10_000 });

    // The scenario's last step is specifically about CRASH-related errors
    // (missing agent_id, unhandled exceptions).
    const crash = errors.filter((e) =>
      /agent_id|agentId|is missing|Cannot read|undefined is not|Uncaught|Unhandled|crash/i.test(e),
    );
    expect(crash, `Crash-related console errors: ${crash.join('\n')}`).toHaveLength(0);
  });
});
