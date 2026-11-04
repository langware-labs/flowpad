import { expect, test, type Page } from '@playwright/test';
import { destroyVibeFixture, openVibe, seedLastVibeChat, type VibeFixture } from '../vibe/_helpers';

/**
 * Every scenario of the journey runtime, driven the way a person drives one.
 *
 * The contract this pins, after journeys were rebuilt around it: **the step
 * number is the address, and the user is the only mover.** `?journeyStep=N` is
 * the whole position, each step names its own destination, and nothing advances
 * without a press. Conditions are a GATE on a press, never a driver — when they
 * drove, the journey and the app disagreed under load and the tour narrated
 * things that had not happened.
 *
 * So this asserts the WORLD, not the tray: when the journey says the workspace is
 * gone, `VibeDisplay` is really out of the DOM and the session is really `standard`.
 *
 * Since 2026-10-11 a mode belongs to a session tab (docs/viewmodes.md): the home
 * is always Vibe, and the exit under review is the open build's own switch.
 * A journey that advanced on a click alone would pass a step-only check and
 * still be lying.
 *
 * Run against a launcher instance, never the user's own dev server:
 *   VITE_PORT=5002 npx playwright test \
 *     --config tests/manual_regression/journey-sweep/playwright.config.ts
 */

const JOURNEY = '@vibe-exit-mode-switch';

/** The authored steps, in order — from the journey document itself, so a drifted
 *  graph fails here rather than silently. */
const STEPS = [
  'Open a build',
  'This is what you have',
  'Now take the exit',
  'Look at what went, then come back',
  'That was the whole exit',
] as const;

let page: Page;
/** One warm session for the file: a fresh context re-pulls the whole Vite dev
 *  module graph, which is slow enough to look like a journey failure. */
let fixture: VibeFixture;
test.beforeAll(async ({ browser, request }) => {
  page = await browser.newPage();
  fixture = await seedLastVibeChat(request, page, 'journey-sweep');
  await page.goto('/');
  await page.locator('[data-tag]').first().waitFor();
});
test.afterAll(async ({ request }) => {
  await page.close();
  await destroyVibeFixture(request, fixture);
});

const url = () => new URL(page.url());
const stepParam = () => url().searchParams.get('journeyStep');
const currentTitle = () => page.locator('li[data-current] p').first();
const stepsLeft = () => page.getByTestId('journey-tray-steps-left');
const workspace = () => page.locator('[data-tag="VibeDisplay"]');
const next = () => page.getByTestId('journey-tray-continue').click();
const back = () => page.getByTestId('journey-tray-back').click();

/** Assert the tray is on step `n` (1-based) — by the URL, the title AND the
 *  counter, so a position that disagrees with what is rendered cannot pass. */
async function expectStep(n: number): Promise<void> {
  await expect(currentTitle(), `step ${n}: ${STEPS[n - 1]}`).toHaveText(STEPS[n - 1]);
  await expect.poll(stepParam, { message: `?journeyStep= on step ${n}` }).toBe(String(n));
  await expect(stepsLeft()).toHaveText(`${STEPS.length - (n - 1)} steps left`);
}

/** The seeded build's own address, with the journey's step on it — how a user
 *  opens a build mid-journey (step 1 cannot open one: a build id is not authored). */
async function openBuildAt(n: number): Promise<void> {
  await page.goto(
    `/dock/vibe/agentic_process-${fixture.processId}?journeyId=${encodeURIComponent(JOURNEY)}&journeyStep=${n}`,
  );
  await expect(workspace()).toBeVisible();
}

/** Open the journey at a given step, cold — no prior navigation. */
async function openAt(n: number, extra = ''): Promise<void> {
  await page.goto(`/?journeyId=${encodeURIComponent(JOURNEY)}&journeyStep=${n}${extra}`);
  await page.locator('[data-tag]').first().waitFor();
}

/** Start from the beginning, through the tray's own Start/Restart. */
async function launch(): Promise<void> {
  await page.goto(`/?journeyId=${encodeURIComponent(JOURNEY)}`);
  await page.locator('[data-tag]').first().waitFor();
  // The tray mounts a beat after the first `[data-tag]`; sampling `count()`
  // at that instant read 0 for BOTH buttons and then waited 60s on `restart`
  // that never exists on a fresh tray. Wait for whichever control the tray
  // actually renders, then press it.
  const start = page.getByTestId('journey-tray-start');
  const restart = page.getByTestId('journey-tray-restart');
  // A finished journey shows BOTH; `.first()` keeps the wait strict-mode safe.
  await expect(start.or(restart).first()).toBeVisible();
  if (await start.count()) await start.click();
  else await restart.click();
  await expectStep(1);
}

/**
 * Opening a build is the slowest thing any step does — a real agent session, and
 * the first attach on a cold instance is far slower than the rest. This does it
 * once, on its own budget, so a later step's gate is not the first to pay for it
 * and a cold instance cannot be mistaken for a stalled gate.
 *
 * A test rather than a `beforeAll`: hooks share the first test's timeout, so
 * warming there simply moved the overflow into that test.
 */
test('a build opens from the rail (warm-up)', async () => {
  await openVibe(page, fixture.processId);
  await expect(workspace()).toBeVisible();
});

test.describe('the journey demonstrates — the app really moves', () => {
  /**
   * Five presses of one button, and the app is somewhere different after each.
   * The home is always Vibe, so the user opens a real build first and the
   * journey then takes that session's own exit out and back.
   */
  test('open a build, take its exit and come back, in five presses of one button', async () => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe');
    await launch();
    await expect(workspace()).toHaveCount(0);

    // The user opens a build (step 1 cannot: a build id is not authored).
    await openBuildAt(1);
    await expectStep(1);
    await next(); // its gate (the workspace) holds — so this lands
    await expectStep(2);

    await next(); // commentary
    await expectStep(3);

    await next(); // the exit under review — the session's Chat button
    await expectStep(4);
    await expect(workspace()).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-view', 'standard');

    await next(); // the way home — the session's Vibe button
    await expectStep(5);
    await expect(workspace()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe');

    await next();
    await expect(page.getByTestId('journey-tray')).toContainText('Completed');
  });

  test('the highlight never reaches the URL', async () => {
    await launch();
    // The step already names its tag and the step is addressed by the URL, so a
    // `?highlight=` would be a second copy of the same fact — the copy that used
    // to get composed onto locations the app had already left.
    for (let n = 1; n <= 3; n++) {
      expect(url().searchParams.get('highlight'), `on step ${n}`).toBeNull();
      await next();
    }
  });
});

test.describe('the step number is the address', () => {
  /** The property none of this had before: a step is a URL you can open. */
  for (const n of [1, 2, 3, 5]) {
    test(`?journeyStep=${n} opens that step cold`, async () => {
      await openAt(n);
      await expectStep(n);
    });
  }

  test('a reload stays on the step', async () => {
    await openAt(4);
    await expectStep(4);
    await page.reload();
    await page.locator('[data-tag]').first().waitFor();
    await expectStep(4);
  });

  test('a step number past the end falls back to Start rather than breaking', async () => {
    await openAt(99);
    await expect(page.getByTestId('journey-tray-start')).toBeVisible();
  });
});

test.describe('Back', () => {
  test('walks back one step at a time, and stops at the first', async () => {
    await openAt(3);
    await back();
    await expectStep(2);
    await back();
    await expectStep(1);
    // Nothing before step 1 — the control is there but does not move.
    await expect(page.getByTestId('journey-tray-back')).toBeDisabled();
  });

  test('returns to the journey even after the user wanders off it', async () => {
    await openAt(3);
    // Off-journey navigation, the case plain history back gets wrong.
    await page.goto('/dock/explorer');
    await page.locator('[data-tag]').first().waitFor();
    await openAt(3);
    await back();
    await expectStep(2);
  });
});

test.describe('the gate holds a press, it does not drive', () => {
  test('a gated step does not land until its condition is true', async () => {
    await launch();

    // Step 1 waits for the workspace to exist. At home there is none, so a press
    // is held — the step does not land on the click alone.
    await expect(workspace()).toHaveCount(0);
    await next();
    await page.waitForTimeout(2000);
    await expectStep(1);

    // Once the workspace is REALLY there, the same press completes.
    await openBuildAt(1);
    await next();
    await expectStep(2);
  });

  test('nothing advances without a press', async () => {
    await openAt(3); // its gate (the workspace) may already be satisfied
    await page.waitForTimeout(3000);
    await expectStep(3); // still there — a satisfied condition moves nothing
  });
});
