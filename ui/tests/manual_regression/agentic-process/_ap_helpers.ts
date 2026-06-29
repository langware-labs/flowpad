/**
 * Shared helpers for agentic-process manual-regression Playwright tests.
 *
 * Centralises the "launch a Claude session and wait for the banner" flow that
 * nearly every scenario in this directory needs. Banner detection waits for the
 * agentic_process URL + a RUNNING process (session_id present, status=running),
 * which is the point at which the ProcessToolbar mounts in the Claude pane.
 */
import { type Page, expect } from '@playwright/test';

export async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', 'true');
    // Every scenario in this category drives the full ProcessToolbar
    // (Restart, Open Terminal, Fork, Worktree, Session Info, Transcript).
    // Those controls only exist in the Advanced view header — the default
    // Standard view renders the simple-chat header without them.
    localStorage.setItem('viewMode', 'advanced');
  });
}

/** Navigate to a fresh interactive shell and wait until xterm is attached. */
export async function gotoNewShell(page: Page) {
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) await skipForNow.click();
  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

/** Open the "+" tab opener menu and pick the Claude Code row. */
export async function startClaude(page: Page) {
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-claude"]').click();
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
 * API base for in-page fetches. Empty string = relative `/api/...` URLs,
 * which the Vite dev server proxies to whatever backend the app itself is
 * wired to — so tests always query the SAME backend as the UI under test.
 * QA_API_URL remains as an explicit override; never hardcode a port here.
 */
export function apiBase(): string {
  return process.env.QA_API_URL || '';
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
