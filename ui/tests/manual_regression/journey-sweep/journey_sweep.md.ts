import { expect, test, type Page } from '@playwright/test';

/**
 * Every scenario of every journey, driven the way a person drives one.
 *
 * A journey makes two promises, and both have broken in review:
 *  1. every authored step is SHOWN — the walk never skips text nobody read;
 *  2. a step advances only when its condition is genuinely met — the narration
 *     never runs ahead of the app.
 *
 * So this sweep asserts the steps AND the world: when the journey says the
 * workspace is gone, `VibeDisplay` is really out of the DOM and the view mode is
 * really `standard`. A journey that advanced on a click alone would pass a
 * step-only check and still be lying.
 *
 * Run against a launcher instance, never the user's own dev server:
 *   VITE_PORT=5002 npx playwright test \
 *     --config tests/manual_regression/journey-sweep/playwright.config.ts
 */

const JOURNEY = '@vibe-exit-mode-switch';

/** The authored steps, in order. The counter and the titles both come from the
 *  journey document, so a drifted graph fails here rather than silently. */
const STEPS = [
  'Start in Vibe',
  'Open a build',
  'This is what you have',
  'Now take the exit',
  'Look at what went, then come back',
  'That was the whole exit',
] as const;

let page: Page;
/** One warm session for the file: a fresh context re-pulls the whole Vite dev
 *  module graph, which is slow enough to look like a journey failure. */
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await page.locator('[data-tag]').first().waitFor();
});
test.afterAll(async () => page.close());

// The tray marks its current row and labels its counter, so the sweep reads
// those rather than scraping innerText — a layout tweak must not silently turn
// this suite green or red.
const currentTitle = () => page.locator('li[data-current] p').first();
const stepsLeft = () => page.getByTestId('journey-tray-steps-left');
const isComplete = () => page.locator('[data-testid="journey-tray"]').getByText('Completed', { exact: false });

/**
 * Open the journey and put it on step 1.
 *
 * `launch()` is idempotent by design — an in-progress run is returned as-is —
 * and a memory run now survives a reload, so a scenario cannot assume it is the
 * first. It resets through the tray's own Restart when a run is already going,
 * which is the same door a user has.
 */
async function launch(startUrl = '/'): Promise<void> {
  const url = new URL(startUrl, 'http://x');
  url.searchParams.set('journeyId', JOURNEY);
  await page.goto(`${url.pathname}${url.search}`);
  await page.locator('[data-tag]').first().waitFor();
  const start = page.getByTestId('journey-tray-start');
  if (await start.count()) await start.click();
  else await page.getByTestId('journey-tray-restart').click();
  await expectStep(1);
}

/** Assert the tray is on step `n` (1-based) — by title AND by counter, so a
 *  skipped step cannot hide behind a matching title. */
async function expectStep(n: number): Promise<void> {
  await expect(currentTitle(), `expected step ${n}: ${STEPS[n - 1]}`).toHaveText(STEPS[n - 1]);
  await expect(stepsLeft(), `counter on step ${n}`).toHaveText(`${STEPS.length - (n - 1)} steps left`);
}

const next = () => page.locator('[data-testid="journey-tray-continue"]').click();
const workspace = () => page.locator('[data-tag="VibeDisplay"]');

test.describe('the walk shows every step', () => {
  for (const startOpen of [false, true]) {
    test(`Next walks all ${STEPS.length} steps · workspace ${startOpen ? 'OPEN' : 'closed'} at start`, async () => {
      await launch(startOpen ? '/?viewMode=vibe' : '/');
      if (startOpen) {
        await page.locator('[data-tag="RailChats"]').click();
        await expect(workspace()).toBeVisible();
      }
      // Every step, in order, one Next each. This is the regression: steps whose
      // condition was already true used to complete themselves, and which ones
      // depended entirely on whether the workspace happened to be open.
      for (let n = 1; n <= STEPS.length; n++) {
        await expectStep(n);
        await next();
      }
      await expect(isComplete()).toBeVisible();
    });
  }
});

test.describe('the journey follows the app, and the app really moves', () => {
  /**
   * The honest path: the user does what each step asks. Nothing is pressed that
   * the journey did not ask for, except on the two steps that authored no
   * condition (`This is what you have`, `That was the whole exit`) — those are
   * commentary and Next is the only way on.
   *
   * Each advance is checked against the WORLD, not just the tray, so the vibe
   * entrance and the exit are proven rather than narrated.
   */
  test('entrance and exit, driven by the real controls', async () => {
    await launch();
    await expectStep(1);

    // ── in ── the wand enters Vibe
    await page.locator('[data-testid="view-toggle-vibe"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe');
    await expectStep(2);

    // the rail opens a real build — the workspace must actually mount
    await page.locator('[data-tag="RailChats"]').click();
    await expect(workspace()).toBeVisible();
    await expectStep(3);

    await next(); // commentary step — no condition authored
    await expectStep(4);

    // ── out ── the exit under review: one unlabelled click
    await page.locator('[data-testid="view-toggle-standard"]').click();
    await expect(workspace()).toHaveCount(0); // the workspace is REALLY gone
    await expect(page.locator('html')).toHaveAttribute('data-view', 'standard');
    await expectStep(5);

    // ── back ── the wand returns, and the workspace really comes back
    await page.locator('[data-testid="view-toggle-vibe"]').click();
    await expect(workspace()).toBeVisible();
    await expectStep(6);

    await next();
    await expect(isComplete()).toBeVisible();
  });

  test('a step does NOT advance until its condition is met', async () => {
    await launch();
    await expectStep(1);
    // Step 2 waits for the workspace to appear. Enter Vibe but open nothing:
    // the journey must sit on step 2 rather than narrate ahead.
    await page.locator('[data-testid="view-toggle-vibe"]').click();
    await expectStep(2);
    await expect(workspace()).toHaveCount(0);
    await page.waitForTimeout(2000);
    await expectStep(2);
  });
});

test.describe('the tray controls', () => {
  test('Skip advances exactly one step', async () => {
    await launch();
    await expectStep(1);
    await page.locator('[data-testid="journey-tray-skip"]').click();
    await expectStep(2);
  });

  test('a reload resumes on the same step', async () => {
    await launch();
    await next();
    await expectStep(2);
    await page.reload();
    await page.locator('[data-tag]').first().waitFor();
    // Neither wedged nor skipped ahead — the cursor is journal-backed.
    await expectStep(2);
  });
});
