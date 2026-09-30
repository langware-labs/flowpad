/**
 * Browser scenario — first-run setup (the `llm-setup` wizard's fire-once
 * `app.tab.ready` trigger).
 *
 *   1. The first tab that loads on a fresh install is steered STRAIGHT to the
 *      setup popup — steps blank, nothing running yet. A live tab is watching
 *      (`_run_llm_setup_trigger`'s own check), so nothing runs until Start is
 *      pressed: racing an install question onto the screen before there was
 *      time to read what any of it is for is the bug this popup exists to
 *      not repeat.
 *   2. Pressing Start is what actually begins first-run setup. A box with no
 *      LLM source THEN lands on the chooser (`/dock/llm-setup`); "Skip for
 *      now" is an answer, and setup steers back to the wizard's popup. A box
 *      that is already funded never sees the chooser at all.
 *   3. The popup lists all four tools and shows the run live.
 *   4. The run settles: every step reaches an answer, and a tool already on
 *      the machine (Git) reads as done.
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

  // 1. Steered straight to the wizard popup — no chooser, no running step, no
  //    Start click yet. A live tab is watching, so the trigger stops there.
  const wizardPage = /\/editor\/wizard\/typeid\//;
  await expect(page).toHaveURL(wizardPage, { timeout: 30_000 }); // do not increase timeout without approval
  await expect(page.getByTestId('wizard-viewer')).toContainText('Finish setting up Flowpad');
  for (const id of STEPS) {
    await expect(page.getByTestId(`wizard-step-${id}`)).toHaveAttribute('data-status', 'not_reached');
  }

  // 2. Start is what actually begins first-run setup. Skipping the chooser
  //    (when it appears) is an answer, and setup steers back to the popup
  //    before the wizard runs — the wizard starts only once the source is
  //    settled, so a step that has left `not_reached` means that phase is over.
  await page.getByTestId('wizard-start').click();
  const skip = page.getByTestId('llm-setup-skip');
  await expect(async () => {
    // The chooser is a small popup with "Choose a source" and "Skip for now"; the "Assistants &
    // keys" dialog opens only from the first, so skipping needs nothing closed first.
    if (await skip.isVisible()) await skip.click({ timeout: 1_000 });
    await expect(page).toHaveURL(wizardPage, { timeout: 1_000 });
    const started = Object.values(await stepStatuses(page)).some((s) => s !== 'not_reached');
    expect(started, 'the wizard has started running').toBe(true);
  }).toPass({ timeout: 30_000 }); // do not increase timeout without approval

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
});
