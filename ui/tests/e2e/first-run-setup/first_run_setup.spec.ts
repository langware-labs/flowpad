/**
 * Browser scenario — first-run setup (the `llm-setup` wizard's fire-once
 * `app.tab.ready` trigger).
 *
 *   1. The first tab that loads on a fresh install is steered into setup,
 *      without anyone clicking anything.
 *   2. A box with no LLM source lands on the chooser (`/dock/llm-setup`);
 *      "Skip for now" is an answer, and setup steers on to the wizard's page.
 *      A box that is already funded never sees the chooser.
 *   3. The page lists all four tools and shows the run live.
 *   4. The run settles: every step reaches an answer, a tool already on the
 *      machine (Git) reads as done, and the Run button is usable again.
 *
 * A tool missing on the machine raises an "Install X?" question in a modal;
 * the spec declines every one, so nothing is installed on the runner — a
 * declined step is still an answer, which is what "settles" checks.
 */
import { expect, test, type Page } from '@playwright/test';

const STEPS = ['claude-code', 'python', 'git', 'node'];
// `stepStatus` / `LIVE_STATE` words that mean "this step has not answered yet".
const UNSETTLED = new Set(['not_reached', 'running']);

// Read inside `toPass` loops, so a missing row fails the attempt quickly rather than
// holding it: the page may be mid-navigation between the wizard and the chooser.
async function stepStatuses(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of STEPS) {
    out[id] = (await page.getByTestId(`wizard-step-${id}`).getAttribute('data-status', { timeout: 1_000 })) ?? '';
  }
  return out;
}

test('a fresh install lands on the setup wizard, which runs to an answer for every tool', async ({ page }) => {
  // The harness sign-in gate is its own onboarding modal, not what this covers.
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

  await page.goto('/');

  // 1. Steered, not clicked: the trigger sends the tab into setup — the wizard's
  //    page, or straight on to the chooser when the box has no LLM source (the
  //    second steer can land before the first one renders).
  const wizardPage = /\/editor\/wizard\/typeid\//;
  await expect(page).toHaveURL(/\/editor\/wizard\/typeid\/|\/dock\/llm-setup/);

  // 2. Skipping the chooser is an answer, and setup steers on to the wizard page
  //    before the wizard runs. The wizard starts only once the source is settled,
  //    so a step that has left `not_reached` on the wizard page means the chooser
  //    phase is over — a visit to the page before the chooser proves nothing.
  const skip = page.getByTestId('llm-setup-skip');
  await expect(async () => {
    // The chooser opens its "Assistants & keys" dialog over the page, and offers
    // "Skip for now" only once that dialog is closed.
    const dialog = page.getByRole('dialog', { name: 'Assistants & keys' });
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close' }).click({ timeout: 1_000 });
    if (await skip.isVisible()) await skip.click({ timeout: 1_000 });
    await expect(page).toHaveURL(wizardPage, { timeout: 1_000 });
    const started = Object.values(await stepStatuses(page)).some((s) => s !== 'not_reached');
    expect(started, 'the wizard has started running').toBe(true);
  }).toPass({ timeout: 30_000 }); // do not increase timeout without approval
  // By test id, not by role: an install question may already be up as a modal,
  // which hides the page behind it from the accessibility tree.
  await expect(page.getByTestId('wizard-viewer')).toContainText('Finish setting up Flowpad');

  // 3. All four tools are on the page.
  for (const id of STEPS) {
    await expect(page.getByTestId(`wizard-step-${id}`)).toBeVisible();
  }

  // 4. Declining every install question, the run reaches an answer for every step.
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
