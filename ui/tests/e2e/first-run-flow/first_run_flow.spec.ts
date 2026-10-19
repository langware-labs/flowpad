/**
 * Browser scenario — the first-run FLOW (`agentic-assets/chart/first-run-wizard-flow`) on a fresh install:
 *
 *   window 1 the wizard  --X-->  window 2 (Run setup | Continue anyway)  -->  window 3 (X)  -->  the end
 *
 * Its own scenario, on its own fresh backend (see its config): the gate must be closed when it starts, and the
 * last test here waives it for the session (an invitation waits for the gate, so its way out opens it). The
 * first test loads the page the moment the backend is up, on a database whose shipped wizard is still being
 * indexed -- the window in which "no wizard row" must not be read as "no wizard".
 *
 *   SETUP_FE_PORT=5001 SETUP_BE_PORT=6001 npx playwright test \
 *     --config ui/tests/e2e/first-run-flow/playwright.config.ts
 */
import { expect, test, type Page } from '@playwright/test';

const BACKEND = `http://localhost:${process.env.SETUP_BE_PORT || '6001'}`;

const popup = (page: Page) => page.getByTestId('wizard-popup');
const windowTwo = (page: Page) => page.getByTestId('first-run-skip-notice');
const windowThree = (page: Page) => page.getByTestId('first-run-how-to');
const invitation = (page: Page) => page.getByTestId('incoming-project-dialog');

/** A page load with the sign-in gate (its own onboarding modal) kept out of the way. */
async function load(page: Page, path = '/') {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await page.goto(path);
}

test('before Start the wizard has an X and no minimize; X leads through windows 2 and 3 and out', async ({ page }) => {
  await load(page);

  // Window 1: nothing is running, so there is nothing to minimize -- X only.
  await expect(popup(page)).toBeVisible({ timeout: 30_000 }); // do not increase timeout without approval
  await expect(page.getByTestId('wizard-close')).toBeVisible();
  await expect(page.getByTestId('wizard-minimize')).toHaveCount(0);

  // X -> window 2, which offers Run setup and Continue anyway. Run setup goes back to window 1.
  await page.getByTestId('wizard-close').click();
  await expect(windowTwo(page)).toBeVisible();
  await expect(page.getByTestId('first-run-run-setup')).toBeVisible();
  await expect(page.getByTestId('first-run-continue-anyway')).toBeVisible();
  await page.getByTestId('first-run-run-setup').click();
  await expect(popup(page)).toBeVisible();

  // X again -> window 2 -> Continue anyway -> window 3: where to run setup again, and no button -- X is the way out.
  await page.getByTestId('wizard-close').click();
  await expect(windowTwo(page)).toBeVisible();
  await page.getByTestId('first-run-continue-anyway').click();
  await expect(windowThree(page)).toBeVisible();
  await expect(windowThree(page)).toContainText('Settings → General → Run setup again');
  await expect(windowThree(page).getByTestId('first-run-continue-anyway')).toHaveCount(0);
  await windowThree(page).getByRole('button', { name: /close/i }).click();

  // The end: nothing of the flow is left, and the page was not navigated to where it already was (that flashed).
  await expect(windowThree(page)).toHaveCount(0);
  await expect(popup(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/homePage=open/);
});

test('the backend says the gate is closed, and a project setup is refused until the wizard ran fully', async ({ request }) => {
  // Answered only once the shipped wizard can be looked up, so a fresh database reads "closed", never "open".
  const state = await request.get(`${BACKEND}/api/v1/graph/wizard/first-run-state`);
  expect(((await state.json()) as { data?: { state?: string } }).data?.state).toBe('closed');

  const projects = await request.get(`${BACKEND}/api/v1/graph/project`);
  expect(projects.ok()).toBe(true);
  const rows = ((await projects.json()) as { data?: Array<{ id: string }> }).data ?? [];
  expect(rows.length, 'a fresh instance has its first project').toBeGreaterThan(0);

  const refused = await request.post(`${BACKEND}/api/v1/graph/project/${rows[0].id}/setup`, { data: {} });

  // 412, never 409: clients read a 409 from these routes as a name collision.
  expect(refused.status()).toBe(412);
  const body = (await refused.json()) as { data?: { blocked?: string } };
  expect(body.data?.blocked).toBe('first_run_setup');
});

// Last: it waives the wizard for the session (an invitation waits for the gate, so its way out opens it).
test('an invitation waits for the wizard: its dialog shows only after the flow has ended', async ({ page }) => {
  const origin = { kind: 'git', owner: 'acme', name: 'course', url: 'https://github.com/acme/course.git', branch: 'main', rel_path: '' };
  const link = `/?action=open&setup_git=1&title=course&sender_name=Dana&git_origin=${encodeURIComponent(JSON.stringify(origin))}`;
  await load(page, link);

  // The wizard comes first, and the invitation's own dialog is nowhere while the flow is on screen.
  await expect(popup(page)).toBeVisible({ timeout: 30_000 }); // do not increase timeout without approval
  await expect(invitation(page)).toHaveCount(0);
  await page.getByTestId('wizard-close').click();
  await expect(windowTwo(page)).toBeVisible();
  await expect(invitation(page)).toHaveCount(0);
  await page.getByTestId('first-run-continue-anyway').click();
  await expect(windowThree(page)).toBeVisible();
  await expect(invitation(page)).toHaveCount(0);

  // The flow ends (X on window 3): only now does the invitation show.
  await windowThree(page).getByRole('button', { name: /close/i }).click();
  await expect(invitation(page)).toBeVisible();
  await expect(page.getByTestId('incoming-project-install')).toBeEnabled();
});
