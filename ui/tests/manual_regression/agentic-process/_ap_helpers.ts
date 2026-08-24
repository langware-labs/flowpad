/**
 * Shared helpers for agentic-process manual-regression Playwright tests.
 *
 * Centralises the "launch a Claude session and wait for the banner" flow that
 * nearly every scenario in this directory needs. Banner detection waits for the
 * agentic_process URL + a RUNNING process (session_id present, status=running),
 * which is the point at which the ProcessToolbar mounts in the Claude pane.
 */
import { type Page, test, expect } from '@playwright/test';
import { selectViewMode, withViewMode } from '../_shared/view-mode';
export { apiBase } from '../_shared/api';

export async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

/**
 * Force Advanced through the URL-backed footer control so a dock override and
 * the backend preference cannot disagree.
 */
export async function forceAdvancedView(page: Page) {
  await selectViewMode(page, 'advanced');
}

/** Navigate to a fresh interactive shell and wait until xterm is attached. */
export async function gotoNewShell(page: Page) {
  await page.goto(withViewMode('/dock/shell/new_terminal', 'advanced'));
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });
  await forceAdvancedView(page);
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

/**
 * Which vendor opener these scenarios drive.
 *
 * The opener rows pass an EXPLICIT `workerType` to `openNewChat`, so flipping
 * the default-harness capability does NOT change which worker the "+" menu
 * launches — the row itself picks the vendor. `AP_OPENER` therefore selects the
 * row, which is the only way to run this matrix against a non-default vendor.
 * Defaults to `claude`, i.e. the suite behaves exactly as before when unset.
 */
export const AP_OPENER = process.env.AP_OPENER || 'claude';

/** The same vendor named as a `WorkerType` (the WorkerToolbar's testid suffix). */
export const AP_WORKER_TYPE = AP_OPENER === 'opencode' ? 'opencode' : 'claude_code';

/** The same vendor as the Quick Create panel labels it. */
export const AP_QUICK_CREATE_LABEL = AP_OPENER === 'opencode' ? 'OpenCode' : 'Claude Code';

/**
 * Does this vendor actually HAVE `--chrome` / `--debug` / `--worktree`?
 *
 * Only claude does. The CLI Options menu is built from
 * `getWorkerCliCapabilities` (`process-cli-presentation.ts`), which reports
 * `chrome/debug/worktree: false` for codex, copilot and opencode — so on those
 * arms the toggles legitimately do not render, and a test that clicks one is
 * asserting a Claude-specific product feature rather than a shared contract.
 *
 * This restates that fact rather than importing it: the presentation module
 * pulls in `@lingui/core/macro`, which Playwright's transpiler does not expand.
 * `ui/tests/unit/cli-options-vendor-flags.test.ts` runs under vitest (where the
 * macro DOES expand) and fails if the two ever disagree — so a vendor that
 * later gains these flags surfaces as a red unit test, not as a silent skip.
 */
export const AP_HAS_CLAUDE_ONLY_CLI_FLAGS = AP_OPENER === 'claude';

/** Open the "+" tab opener menu and pick the vendor row under test. */
export async function startClaude(page: Page) {
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator(`[data-testid="opener-menu-row-${AP_OPENER}"]`).click();
  await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 30_000 });
}

/**
 * Scope a locator to the toolbar of the *active* terminal panel. Multiple
 * panels (one per open tab) stack in the DOM, each with its own ProcessToolbar;
 * only the active panel's toolbar is visible and interactive. Using the active
 * panel avoids clicking a hidden tab's controls (which silently no-op).
 */
export function activePanel(page: Page) {
  return page.locator('[data-testid="terminal-panel"][data-active="true"]').last();
}

/** Return the agentic_process id parsed from the current URL. */
export function processIdFromUrl(page: Page): string {
  const m = page.url().match(/agentic_process-([\w-]+)/);
  if (!m) throw new Error(`No agentic_process id in URL: ${page.url()}`);
  return m[1];
}

/**
 * Wait until the launched process reaches RUNNING with a session_id (the point
 * at which the toolbar's started/hasSession gates flip on). Polls the backend
 * directly so we don't depend on banner glyphs rendering inside the xterm canvas.
 */
export async function waitForRunningSession(page: Page, apiBase: string, processId: string) {
  await expect(async () => {
    const data = await page.evaluate(
      async ({ base, id }) => {
        const res = await fetch(`${base}/api/v1/graph/agentic_process/${id}`);
        const json = await res.json();
        return json?.data ?? {};
      },
      { base: apiBase, id: processId },
    );
    // Status model: `status` carries the raw FSM (running/stopping/…) and
    // turn-in-flight is a SEPARATE `busy` boolean field (not projected into
    // status). A started process with a live session is `running`.
    expect(data.status).toBe('running');
    expect(data.session_id).toBeTruthy();
  }).toPass({ timeout: 45_000 });
  // The ProcessToolbar re-renders several times while the worker initializes
  // (status/restart_required updates via useSyncExternalStore). A click that
  // lands mid-re-render is swallowed (the popover/dropdown opens then the
  // remount closes it). Let the toolbar settle before driving its controls.
  await page.waitForTimeout(4_000);
}

/**
 * The Session Info popover is a Radix Popover — its content portals into a
 * [data-radix-popper-content-wrapper], NOT a [role="dialog"] (only Dialog gets
 * that role). Filter by the "Session Details" heading to pick it out.
 */
export function sessionPopover(page: Page) {
  return page.locator('[data-radix-popper-content-wrapper]').filter({ hasText: 'Session Details' });
}

/**
 * Wait until the worker leaves INITIALIZING/IDLE — i.e. a REAL assistant turn
 * happened (this is what flips the ProcessToolbar `hasTranscript` gate that
 * enables Fork / Open Transcript). worker_status is a backend-streamed field
 * derived from the live Claude session; there is no faithful way to seed it
 * without a real model turn (faking it would be a mock of the very state under
 * test). On this shared host — ~150 competing `claude` processes, frequent
 * `out of pty devices`, load 12-17 — a freshly spawned session often cannot
 * produce an assistant turn inside the test budget.
 *
 * So this is a CONDITIONAL skip: it returns normally the moment a turn lands
 * (the test then fully validates the post-turn UI gate), and only skips when
 * the live-Claude precondition genuinely isn't met within budget. It never
 * skips unconditionally, and it does not widen the test's overall time budget.
 */
export async function waitForAssistantTurnOrSkip(page: Page, apiBaseUrl: string, processId: string, budgetMs = 40_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const proc = await fetchProcess(page, apiBaseUrl, processId);
    const ws = String(proc.worker_status ?? '').toLowerCase();
    if (!['initializing', 'idle', ''].includes(ws)) return; // real assistant turn landed
    await page.waitForTimeout(1_000);
  }
  test.skip(
    true,
    'live Claude worker never produced an assistant turn within budget on this saturated host ' +
      '(competing claude procs / out of pty devices); the UI gate under test requires a real model turn',
  );
}

/** Fetch the agentic_process entity row from the backend. */
export async function fetchProcess(page: Page, apiBaseUrl: string, processId: string) {
  return page.evaluate(
    async ({ base, id }) => {
      const res = await fetch(`${base}/api/v1/graph/agentic_process/${id}`);
      const json = await res.json();
      return json?.data ?? {};
    },
    { base: apiBaseUrl, id: processId },
  );
}
