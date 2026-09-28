/**
 * Browser scenario — first-run setup (the `llm-setup` wizard's fire-once
 * `app.tab.ready` trigger).
 *
 *   1. The first tab that loads on a fresh install is steered to the wizard's
 *      own page, without anyone clicking anything.
 *   2. The page lists all six tools and shows the run live.
 *   3. The run settles: every step reaches an answer, a tool already on the
 *      machine (Git) reads as done, and the Run button is usable again.
 *
 * A tool missing on the machine raises an "Install X?" question in a modal;
 * the spec declines every one, so nothing is installed on the runner — a
 * declined step is still an answer, which is what "settles" checks.
 */
import { expect, test, type Page } from '@playwright/test';

const STEPS = ['jq', 'ripgrep', 'claude-code', 'python', 'git', 'node'];
// `stepStatus` / `LIVE_STATE` words that mean "this step has not answered yet".
const UNSETTLED = new Set(['not_reached', 'running']);

async function stepStatuses(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of STEPS) {
    out[id] = (await page.getByTestId(`wizard-step-${id}`).getAttribute('data-status')) ?? '';
  }
  return out;
}

test('a fresh install lands on the setup wizard, which runs to an answer for every tool', async ({ page }) => {
  // The harness sign-in gate is its own onboarding modal, not what this covers.
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

  await page.goto('/');

  // 1. Steered, not clicked: the trigger sends the tab to the wizard's page.
  await expect(page).toHaveURL(/\/editor\/wizard\/typeid\//);
  const viewer = page.getByTestId('wizard-viewer');
  await expect(viewer.getByRole('heading', { name: 'llm-setup' })).toBeVisible();

  // 2. All six tools are on the page.
  for (const id of STEPS) {
    await expect(page.getByTestId(`wizard-step-${id}`)).toBeVisible();
  }

  // 3. Declining every install question, the run reaches an answer for every step.
  const modal = page.getByTestId('ask-modal');
  await expect(async () => {
    if (await modal.isVisible()) {
      await page.getByTestId('ask-modal-cancel').click();
    }
    const statuses = await stepStatuses(page);
    const pending = Object.entries(statuses).filter(([, s]) => UNSETTLED.has(s));
    expect(pending, `steps still without an answer: ${JSON.stringify(statuses)}`).toEqual([]);
  }).toPass({ timeout: 90_000 }); // do not increase timeout without approval

  const statuses = await stepStatuses(page);
  expect(['satisfied', 'completed'], `git is on every runner: ${JSON.stringify(statuses)}`).toContain(statuses.git);
  await expect(page.getByTestId('wizard-run')).toBeEnabled();
});
