/**
 * Creating and viewing a skill shows no SkillParseError (FLOWPAD-1678).
 * Source: skill_editor_error_skillparseerror_invalid_skillmd_format_mi.md
 *
 * Skills are folded into the unified Assets browser at /dock/assets/list/skill.
 * The load-bearing assertion is the absence of
 * "SkillParseError: Invalid SKILL.md format" across a list -> home -> list
 * round-trip. The create step is best-effort (only if a create control exists).
 */
import { test, expect } from '@playwright/test';

test.describe('Skill editor — no SkillParseError', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Creating and viewing a skill shows no SkillParseError', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/assets/list/skill');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(page.url()).toContain('/dock/assets/list/skill');
    await page.waitForTimeout(2_000);

    // Best-effort: if a New/Add/Create control exists in the assets header, click it.
    const createBtn = page
      .getByRole('button', { name: /new skill|new|add|create/i })
      .first();
    if (await createBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await createBtn.click().catch(() => {});
      await page.waitForTimeout(2_000);
    }

    // Round-trip: home -> back to skills list.
    await page.goto('/dock/home');
    await page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first().waitFor({ state: 'visible', timeout: 25_000 });
    await page.goto('/dock/assets/list/skill');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await expect(page.locator('#root')).not.toBeEmpty();
    await page.waitForTimeout(2_000);

    // The skills list must load without "SkillParseError: Invalid SKILL.md format".
    const offending = errors.filter((e) => /SkillParseError/i.test(e) || /Invalid SKILL\.md format/i.test(e));
    expect(offending, `SkillParseError console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
