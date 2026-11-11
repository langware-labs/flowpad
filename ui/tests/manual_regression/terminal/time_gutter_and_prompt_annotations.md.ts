/**
 * Time gutter & prompt annotations.
 * Source: time_gutter_and_prompt_annotations.md (10 tests).
 *
 * The trace gutter and time gutter render for any active AgenticProcess
 * (gate: `!!process`). The annotation gutter requires a real worker session_id
 * (gate: `!!process.session_id`) — set once the live Claude banner registers.
 *
 * Tests 1, 6, 7, 8, 9 need only a started Claude process (banner-level) and are
 * automated by launching a live Claude session and waiting for the ribbon.
 * Tests 2, 3, 4, 5, 10 require a process that has COMPLETED at least one
 * prompt/response cycle (sky-blue PTY segment borders / positioned prompt
 * annotation markers) — that needs Claude to actively think+respond for minutes
 * with non-deterministic output, so they are skipped per the live-claude rule.
 *
 * Column visibility & trace filters: the ProcessToolbar debug menu
 * (aria-label="Debug"), "Gutters" section, checkboxes: "Trace events", "Time gutter",
 * "Annotations", "Prompt annotations", time fields "Time", "Index (seq)",
 * "Line", "Abs line", "Row time range", "Anchor time range".
 * Column header bar (18px strip) hide/show buttons:
 *   "Hide Trace — …" / "Show Trace", "Hide Annotations — …" / "Show Annotations".
 */
import { test, expect, type Page } from '@playwright/test';
import { RIBBON_TABS, dismissSetupModal, ensureAdvancedView, startClaudeSession } from './helpers';
import { adjusted } from '../../adjustableTimeout';

/** A live, signed-in Claude worker on this instance (QA hosts that have one set LIVE_CLAUDE=1). */
const LIVE_CLAUDE = process.env.LIVE_CLAUDE === '1';

let cachedAgenticUrl: string | null = null;

async function gotoAgenticProcess(page: Page) {
  const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
  const ribbon = activePanel.locator(RIBBON_TABS);

  if (cachedAgenticUrl) {
    await page.goto(cachedAgenticUrl);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: adjusted(15_000) });
    if (await ribbon.isVisible({ timeout: adjusted(10_000) }).catch(() => false)) {
      await ensureAdvancedView(page);
      // A session still starting re-renders its toolbar and drops an open menu: act once it has painted.
      await ensurePtyContent(page);
      return;
    }
}

  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: adjusted(2_000) }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: adjusted(60_000) });

  if (!page.url().includes('agentic_process-')) {
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: adjusted(30_000) });
    await startClaudeSession(page);
    await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: adjusted(60_000) });
}
  // Ribbon visible = process toolbar/InteractiveTerminal mounted (banner level).
  await expect(ribbon).toBeVisible({ timeout: adjusted(60_000) });
  // The column header bar (Hide/Show buttons) and the annotation gutter follow the Dev switch (71e9272c6).
  await ensureAdvancedView(page);
  await ensurePtyContent(page);
  cachedAgenticUrl = page.url();
}

/**
 * Ensure the PTY has rendered content rows so the time/trace gutters have a
 * non-zero height (a fresh process shows an empty 0-height gutter). If the
 * Claude tab is in the pending "(new)" state, click its in-panel "Start Claude"
 * affordance; then wait for the xterm buffer to populate.
 */
async function ensurePtyContent(page: Page) {
  const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
  const start = activePanel.getByRole('button', { name: /Start Claude/ });
  if (await start.isVisible({ timeout: adjusted(3_000) }).catch(() => false)) {
    await start.click().catch(() => {});
}
  await expect(async () => {
    const txt = (await activePanel.locator('.xterm-rows').first().textContent()) ?? '';
    expect(txt.trim().length).toBeGreaterThan(0);
}).toPass({ timeout: adjusted(60_000) });
}

function colDropdown(page: Page) {
  // The toolbar of the shown session (hidden panels keep their own toolbars mounted).
  return page.locator('[data-testid="process-toolbar-debug"]:visible').first();
}

/**
 * Put one Gutters item of the debug menu in a known state. Column visibility is a backend
 * preference now (prefMan), so a run that stopped half way leaves it for the next one: each test
 * sets what it starts from instead of assuming the default.
 */
async function setGutter(page: Page, name: RegExp, on: boolean) {
  await openDebugMenu(page);
  const item = page.getByRole('menuitemcheckbox', { name });
  await expect(item).toBeVisible({ timeout: adjusted(5_000) });
  if (((await item.getAttribute('aria-checked')) === 'true') !== on) await item.click();
  await expect(item).toHaveAttribute('aria-checked', String(on));
  await closeDebugMenu(page);
}

/**
 * Open the debug menu. A session that is still starting re-renders its toolbar and drops a menu
 * opened in that window (seen 2026-11-10 on a cold Claude start), so click until the menu is open.
 */
async function openDebugMenu(page: Page) {
  const gutters = page.getByRole('menuitemcheckbox', { name: /^Time gutter/ });
  // Click only while the trigger says closed: a second click on an opening menu would close it.
  await expect(async () => {
    if ((await colDropdown(page).getAttribute('data-state')) !== 'open') await colDropdown(page).click();
    await expect(gutters).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: adjusted(15_000) });
}

/** The instance's preferences.json write that follows a preference change. */
function savedPreferences(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes('/preferences.json') && r.request().method() === 'POST',
    { timeout: adjusted(15_000) },
  );
}

/** Close the debug menu completely: Escape inside the Time Gutter Fields submenu closes only the submenu. */
async function closeDebugMenu(page: Page) {
  await expect(async () => {
    if ((await colDropdown(page).getAttribute('data-state')) === 'open') await page.keyboard.press('Escape');
    await expect(colDropdown(page)).toHaveAttribute('data-state', 'closed', { timeout: 1_000 });
    await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: adjusted(10_000) });
}

async function openColDropdown(page: Page) {
  await openDebugMenu(page);
  // The per-field toggles (Time, Index, Abs line, …) live in a submenu.
  await page.getByRole('menuitem', { name: 'Time Gutter Fields' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /^Time$/ })).toBeVisible({ timeout: adjusted(5_000) });
}

async function toggleCheckbox(page: Page, name: RegExp | string) {
  await page.getByRole('menuitemcheckbox', { name }).click();
}

// Banner/ribbon-dependent tests cannot run headlessly here: the time/trace/
// annotation gutters only mount inside a LIVE Claude AgenticProcess
// InteractiveTerminal, and the live Claude worker/ribbon does not materialize
// in this QA harness (REST-AP has shell_id/session_id null and never mounts the
// ribbon; the real-CLI startClaudeSession does not register a process within
// budget — the established prompt_index_panel.md.ts ribbon tests time out
// identically here). This is the live-claude skip category.
// Skip-challenge findings (2026-06-04, qa-2 with FLOWPAD_CLAUDE_HOME set):
//  - The ribbon + Columns&Trace dropdown + trace/time/annotation gutter
//    STRUCTURE DO render headlessly (corrects the earlier "ribbon never
//    appears" claim).
//  - On a WARM Claude session (no preceding DB clear), sending a trivial turn
//    produced sky-blue PTY segment borders in the time gutter at ~8.6s — so
//    the segment-border assertions (tests 2/3) are achievable when a started
//    session already exists.
//  - BUT each scenario requires a clean-state DB clear first, and a COLD Claude
//    start after the clear does NOT produce PTY content within the 180s test
//    budget: the worker sits at worker_status="pending_user" (the Claude CLI's
//    interactive trust/permission gate) — observed stuck 160s+, the xterm
//    buffer stays empty so the time gutter has 0 height, and no prompt/response
//    cycle completes. The gutters need PTY content (tests 1/2/3/8/10) or a
//    COMPLETED prompt (tests 4/5), neither of which materializes from a cold
//    headless start. This is the genuine live-claude blocker (a non-completing
//    interactive gate, not merely a long response).
const LIVE_CLAUDE_SKIP =
  'live-claude: needs a LIVE Claude PTY with rendered content (tests 1/2/3/8/10) or a COMPLETED prompt/response cycle (tests 4/5). Verified 2026-06-04 (FLOWPAD_CLAUDE_HOME set): the ribbon+gutter STRUCTURE renders and a WARM session produced sky segment borders at ~8.6s, but a cold Claude start after the mandatory DB clear stalls at worker_status=pending_user (interactive trust/permission gate) for 160s+ with an empty xterm buffer, so no gutter content / completed prompt appears within the 180s budget. skip_challenge_required.';

test.describe('Time gutter & prompt annotations', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
});

  test('test 1: Time gutter field columns are aligned with fixed widths', async ({ page }) => {
    test.skip(!LIVE_CLAUDE, LIVE_CLAUDE_SKIP);
    test.setTimeout(adjusted(60_000));
    await gotoAgenticProcess(page);
    await ensurePtyContent(page);

    await openColDropdown(page);
    // Enable Time gutter.
    const timeItem = page.getByRole('menuitemcheckbox', { name: /Time gutter/ });
    if ((await timeItem.getAttribute('aria-checked')) !== 'true') await timeItem.click();
    // Enable two time sub-fields (PTY time + Index/seq).
    const timeField = page.getByRole('menuitemcheckbox', { name: /^Time$/ });
    if ((await timeField.getAttribute('aria-checked')) !== 'true') await timeField.click();
    const indexField = page.getByRole('menuitemcheckbox', { name: /Index \(seq\)/ });
    if ((await indexField.getAttribute('aria-checked')) !== 'true') await indexField.click();
    // Start without the field this test adds (the field set is a backend preference a stopped run keeps).
    const absOff = page.getByRole('menuitemcheckbox', { name: /Abs line/ });
    if ((await absOff.getAttribute('aria-checked')) === 'true') await absOff.click();
    await closeDebugMenu(page);

    // Time gutter column is visible.
    const gutter = page.locator('[data-testid="time-gutter"]:visible').first();
    await expect(gutter).toBeVisible({ timeout: adjusted(10_000) });
    const widthTwoFields = (await gutter.boundingBox())!.width;

    // Enable a third field (Abs line) → gutter width increases.
    await openColDropdown(page);
    const absField = page.getByRole('menuitemcheckbox', { name: /Abs line/ });
    if ((await absField.getAttribute('aria-checked')) !== 'true') await absField.click();
    await closeDebugMenu(page);
    await expect
      .poll(async () => (await gutter.boundingBox())!.width, { timeout: adjusted(10_000) })
      .toBeGreaterThan(widthTwoFields);
});

  test('test 2: PTY segment border markers appear in time gutter', async () => {
    // Sky-blue PTY segment borders DID appear at ~8.6s on a WARM session, but a
    // cold start after the mandatory DB clear leaves the PTY empty (pending_user
    // gate) so no segments form within budget. See LIVE_CLAUDE_SKIP.
    test.skip(true, LIVE_CLAUDE_SKIP);
});

  test('test 3: PTY segment border tooltip shows start/end anchor', async () => {
    test.skip(true, LIVE_CLAUDE_SKIP);
});

  test('test 4: Prompt annotations appear in annotation gutter after replay', async () => {
    // The prompt annotation (kind==='prompt') never positioned in 160s — the
    // worker stays at worker_status=pending_user (interactive permission gate),
    // so the prompt/response cycle never completes. See LIVE_CLAUDE_SKIP.
    test.skip(true, LIVE_CLAUDE_SKIP);
});

  test('test 5: Prompt annotations do not appear before replay is complete', async () => {
    test.skip(true, LIVE_CLAUDE_SKIP);
});

  test('test 6: Column header bar — hide and restore trace column', async ({ page }) => {
    test.skip(!LIVE_CLAUDE, LIVE_CLAUDE_SKIP);
    test.setTimeout(adjusted(60_000));
    await gotoAgenticProcess(page);
    await setGutter(page, /^Trace events/, true);

    // Column header bar (18px strip) is visible; trace gutter visible.
    const traceGutter = page.locator('[data-testid="trace-gutter"]:visible').first();
    await expect(traceGutter).toBeVisible({ timeout: adjusted(15_000) });

    // Click the EyeOff (Hide Trace) button in the Trace header cell.
    await page.locator('button[aria-label^="Hide Trace"]:visible').first().click();
    await expect(traceGutter).toBeHidden({ timeout: adjusted(10_000) });
    // The Trace header now shows the Activity icon (Show Trace).
    await expect(page.locator('button[aria-label="Show Trace"]:visible').first()).toBeVisible({ timeout: adjusted(5_000) });

    // Click to restore.
    await page.locator('button[aria-label="Show Trace"]:visible').first().click();
    await expect(traceGutter).toBeVisible({ timeout: adjusted(10_000) });
});

  test('test 7: Column header bar — hide and restore annotations column', async ({ page }) => {
    test.skip(!LIVE_CLAUDE, LIVE_CLAUDE_SKIP + ' (also needs a real worker session_id for the annotation gutter.)');
    test.setTimeout(adjusted(60_000));
    await gotoAgenticProcess(page);

    // Annotation gutter requires a worker session_id (set when the banner
    // registers). Ensure annotations column is enabled via the dropdown first.
    await openColDropdown(page);
    const annItem = page.getByRole('menuitemcheckbox', { name: /^Annotations/ });
    if ((await annItem.getAttribute('aria-checked')) !== 'true') await annItem.click();
    await closeDebugMenu(page);

    const annGutter = page.locator('[data-testid="annotation-gutter"]:visible').first();
    await expect(annGutter).toBeVisible({ timeout: adjusted(20_000) });

    await page.locator('button[aria-label^="Hide Annotations"]:visible').first().click();
    await expect(annGutter).toBeHidden({ timeout: adjusted(10_000) });
    await expect(page.locator('button[aria-label="Show Annotations"]:visible').first()).toBeVisible({ timeout: adjusted(5_000) });

    await page.locator('button[aria-label="Show Annotations"]:visible').first().click();
    await expect(annGutter).toBeVisible({ timeout: adjusted(10_000) });
});

  test('test 8: Column visibility persists across page refresh', async ({ page }) => {
    test.skip(!LIVE_CLAUDE, LIVE_CLAUDE_SKIP);
    test.setTimeout(adjusted(60_000));
    await gotoAgenticProcess(page);
    await setGutter(page, /^Trace events/, true);

    const traceGutter = page.locator('[data-testid="trace-gutter"]:visible').first();
    await expect(traceGutter).toBeVisible({ timeout: adjusted(15_000) });

    // Hide the trace column. Column visibility is a backend preference (the instance's
    // preferences.json): reload only once that write has landed.
    let saved = savedPreferences(page);
    await page.locator('button[aria-label^="Hide Trace"]:visible').first().click();
    await expect(traceGutter).toBeHidden({ timeout: adjusted(10_000) });
    await saved;

    // Reload — the header shows "Show Trace" once the panel mounts, and no trace gutter.
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: adjusted(30_000) });
    await expect(page.locator('button[aria-label="Show Trace"]:visible').first()).toBeVisible({ timeout: adjusted(30_000) });
    await expect(page.locator('[data-testid="trace-gutter"]:visible').first()).toBeHidden({ timeout: adjusted(15_000) });

    // Restore via the Activity (Show Trace) icon.
    saved = savedPreferences(page);
    await page.locator('button[aria-label="Show Trace"]:visible').first().click();
    await expect(page.locator('[data-testid="trace-gutter"]:visible').first()).toBeVisible({ timeout: adjusted(10_000) });
    await saved;

    // Reload again — now visible persists.
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: adjusted(30_000) });
    await expect(page.locator('[data-testid="trace-gutter"]:visible').first()).toBeVisible({ timeout: adjusted(15_000) });
});

  test('test 9: debug menu — Trace and Annotations column toggles (entry-point parity)', async ({ page }) => {
    test.skip(!LIVE_CLAUDE, LIVE_CLAUDE_SKIP);
    test.setTimeout(adjusted(60_000));
    await gotoAgenticProcess(page);
    await setGutter(page, /^Trace events/, true);

    const traceGutter = page.locator('[data-testid="trace-gutter"]:visible').first();
    const annGutter = page.locator('[data-testid="annotation-gutter"]:visible').first();
    await expect(traceGutter).toBeVisible({ timeout: adjusted(15_000) });

    // Uncheck "Trace events" → trace gutter disappears.
    await openColDropdown(page);
    await toggleCheckbox(page, /Trace events/);
    await closeDebugMenu(page);
    await expect(traceGutter).toBeHidden({ timeout: adjusted(10_000) });

    // Re-check "Trace events" → reappears.
    await openColDropdown(page);
    await toggleCheckbox(page, /Trace events/);
    await closeDebugMenu(page);
    await expect(traceGutter).toBeVisible({ timeout: adjusted(10_000) });

    // Ensure annotations on, then toggle off/on via dropdown.
    await openColDropdown(page);
    const annItem = page.getByRole('menuitemcheckbox', { name: /^Annotations/ });
    if ((await annItem.getAttribute('aria-checked')) !== 'true') await annItem.click();
    await closeDebugMenu(page);
    await expect(annGutter).toBeVisible({ timeout: adjusted(20_000) });

    await openColDropdown(page);
    await toggleCheckbox(page, /^Annotations/);
    await closeDebugMenu(page);
    await expect(annGutter).toBeHidden({ timeout: adjusted(10_000) });

    await openColDropdown(page);
    await toggleCheckbox(page, /^Annotations/);
    await closeDebugMenu(page);
    await expect(annGutter).toBeVisible({ timeout: adjusted(10_000) });
});

  test('test 10: Time-gutter row/anchor time-range fields render extra columns', async ({ page }) => {
    test.skip(!LIVE_CLAUDE, LIVE_CLAUDE_SKIP);
    test.setTimeout(adjusted(60_000));
    await gotoAgenticProcess(page);

    // This test's intent (widening the gutter when debugTime/refTime fields are
    // enabled) is structural and does not need a completed prompt cycle — the
    // gutter renders for any active process. Enable Time gutter + a base field.
    await openColDropdown(page);
    const timeItem = page.getByRole('menuitemcheckbox', { name: /Time gutter/ });
    if ((await timeItem.getAttribute('aria-checked')) !== 'true') await timeItem.click();
    const timeField = page.getByRole('menuitemcheckbox', { name: /^Time$/ });
    if ((await timeField.getAttribute('aria-checked')) !== 'true') await timeField.click();
    // Start from the base width: neither range field on (a stopped run keeps them in the backend preference).
    for (const name of [/Row time range/, /Anchor time range/]) {
      const field = page.getByRole('menuitemcheckbox', { name });
      if ((await field.getAttribute('aria-checked')) === 'true') await field.click();
    }
    await closeDebugMenu(page);

    const gutter = page.locator('[data-testid="time-gutter"]:visible').first();
    await expect(gutter).toBeVisible({ timeout: adjusted(10_000) });
    const baseWidth = (await gutter.boundingBox())!.width;

    // Enable "Row time range" (debugTime) → gutter widens.
    await openColDropdown(page);
    await toggleCheckbox(page, /Row time range/);
    await closeDebugMenu(page);
    await expect.poll(async () => (await gutter.boundingBox())!.width, { timeout: adjusted(10_000) }).toBeGreaterThan(baseWidth);
    const afterDebug = (await gutter.boundingBox())!.width;

    // Enable "Anchor time range" (refTime) → gutter widens again.
    await openColDropdown(page);
    await toggleCheckbox(page, /Anchor time range/);
    await closeDebugMenu(page);
    await expect.poll(async () => (await gutter.boundingBox())!.width, { timeout: adjusted(10_000) }).toBeGreaterThan(afterDebug);

    // Disable both → returns to base width.
    await openColDropdown(page);
    await toggleCheckbox(page, /Row time range/);
    await toggleCheckbox(page, /Anchor time range/);
    await closeDebugMenu(page);
    await expect.poll(async () => (await gutter.boundingBox())!.width, { timeout: adjusted(10_000) }).toBe(baseWidth);
});
});
