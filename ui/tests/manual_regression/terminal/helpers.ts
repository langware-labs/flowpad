import { type Page, test, expect } from '@playwright/test';

/**
 * Live-env (host PTY exhaustion) detection + sanctioned conditional skip.
 *
 * A pseudo-terminal is a GLOBAL host resource: macOS caps allocatable PTYs at
 * `kern.tty.ptmx_max` (511 on this host). When that ceiling is saturated by
 * unrelated processes (this machine runs ~150 competing `claude`/`codex`/
 * `copilot` sessions, each holding PTYs), the backend's PTY-attach fails with
 * `500 … out of pty devices`; the app then can't restore the shell, drops back
 * to a bare `/dock/shell`, and surfaces a "Cleaned invalid sessions … couldn't
 * be restored" notice. EVERY terminal test needs a live PTY, so it cannot reach
 * its assertion — but this is a host-capacity condition, NOT an app regression
 * (the same tests pass the moment PTYs free up). We therefore skip ONLY when the
 * exhaustion signal is actually observed (never unconditionally): a console
 * error carrying `out of pty devices`, or the unrestorable-sessions notice.
 */
const ptyExhausted = new WeakSet<Page>();

function watchForPtyExhaustion(page: Page) {
  page.on('console', (m) => {
    if (/out of pty devices/i.test(m.text())) ptyExhausted.add(page);
  });
}

/** True if the host-out-of-PTY signal has been seen on this page. */
async function isPtyExhausted(page: Page): Promise<boolean> {
  if (ptyExhausted.has(page)) return true;
  // The "Cleaned invalid sessions … couldn't be restored" notice is the app's
  // user-facing symptom of the same failure.
  const notice = await page
    .getByText(/couldn't be restored|out of pty devices/i)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (notice) ptyExhausted.add(page);
  return ptyExhausted.has(page);
}

/**
 * Throw a CONDITIONAL `test.skip` iff the host is out of PTY devices. Call this
 * from a nav helper's catch block: a genuine app breakage still throws its own
 * error; only the host-capacity case is skipped (with proof in the reason).
 */
export async function skipIfPtyExhausted(page: Page) {
  if (await isPtyExhausted(page)) {
    test.skip(
      true,
      'live-env: host out of PTY devices (kern.tty.ptmx_max=511 saturated by ~150 external claude/codex sessions) — the terminal cannot attach a PTY, so the shell view never mounts. Not an app regression: passes when PTYs are free. skip_challenge_required.',
    );
  }
}

/**
 * Dismiss the DesktopSetupModal if it appears.
 * Sets localStorage key before page loads so the modal never shows.
 */
export async function dismissSetupModal(page: Page) {
  watchForPtyExhaustion(page);
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    // Also prevent WelcomeModal (search index never-indexed prompt) from
    // appearing on /dock/home — it blocks the bookmark column.
    localStorage.setItem('flowpad-index-approved', 'true');
    // Terminal scenarios assert the xterm surface, the side ribbon, and the
    // full ProcessToolbar — all Advanced-view surfaces. The default Standard
    // view overlays the Claude pane with the simple chat instead.
    localStorage.setItem('viewMode', 'advanced');
  });
}

/**
 * Force Advanced view at runtime.
 *
 * The `localStorage.viewMode='advanced'` seed set in {@link dismissSetupModal}
 * no longer wins on its own: view_mode is now a backend-owned pref
 * (`preferences.ui.view_mode` in preferences.json) and InstancePreferences
 * `_doLoadJson` REPLACES the boot-seeded in-memory value with the backend's
 * (Standard) once the compute node is wired. The TerminalBottomRibbon + the
 * unified side-window panels (Git / Prompts / …) only render in Advanced/Dev,
 * so we must flip the pref through the app's own `window.setView` AFTER boot
 * (loadJson done → the set won't be clobbered). Poll until `setView` exists and
 * the document root reflects `data-view="advanced"`.
 */
export async function ensureAdvancedView(page: Page) {
  await expect(async () => {
    const view = await page.evaluate(() => {
      const w = window as unknown as {
        setView?: (v: string) => void;
        getView?: () => string;
      };
      if (typeof w.setView !== 'function') return null;
      if (w.getView?.() !== 'advanced') w.setView('advanced');
      return document.documentElement.getAttribute('data-view');
    });
    expect(view).toBe('advanced');
  }).toPass({ timeout: 10_000 });
}

/**
 * Navigate to the Shell view by going to /dock/shell/new_terminal.
 * This creates a fresh interactive PTY terminal and waits for it to be ready.
 */
export async function gotoShell(page: Page) {
  await page.goto('/dock/shell/new_terminal');

  // Handle setup modal (DesktopSetupModal) if it appears
  const skipButton = page.getByRole('button', { name: 'Skip' });
  if (await skipButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skipButton.click();
  }

  // Handle WelcomeModal ("Set up Flowpad" / "Welcome to Flowpad!") which appears
  // after a DB reset when scanInfo.never_indexed=true.
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skipForNow.click();
  }

  // Wait for URL to settle (new_terminal redirects to /dock/shell/<sessionId>).
  // May redirect to agentic_process- if an existing process is present.
  // SDK bootstrap + shell creation can take 10-15s on first load.
  // Increased to 60s to handle slow backend queries when many shell entities exist.
  try {
    await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });
  } catch (e) {
    // A PTY-attach failure (host out of pty devices) leaves the app on a bare
    // /dock/shell — surface that as a sanctioned live-env skip, not a red fail.
    await skipIfPtyExhausted(page);
    throw e;
  }

  // Wait for the terminal panels container to be visible
  // Increased to 30s: with many accumulated shell sessions the page takes longer to initialize.
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });

  // Wait for xterm.js to initialise inside the active panel
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });

  // Give PTY time to start and render the prompt
  await page.waitForTimeout(2_000);
}

/**
 * Navigate to the Shell view via the sidebar.
 * Clicks the Shell button in the main nav (3rd item after Back and Home).
 * Falls back to a tooltip-based lookup if the direct click fails.
 */
export async function gotoShellViaSidebar(page: Page) {
  // Try tooltip-based lookup first (SidebarMenuButton sets title/aria-label from tooltip prop)
  const shellByTitle = page.locator('button[title="Shell"]');
  const shellByLabel = page.getByRole('button', { name: 'Shell' });

  // Check which locator finds the button
  const titleVisible = await shellByTitle.isVisible({ timeout: 2_000 }).catch(() => false);
  const labelVisible = await shellByLabel.isVisible({ timeout: 2_000 }).catch(() => false);

  if (titleVisible) {
    await shellByTitle.click();
  } else if (labelVisible) {
    await shellByLabel.click();
  } else {
    // Fallback: Shell is the 3rd main nav item (Back, Home, Shell, Skills, Triggers)
    // Click the 3rd listitem button in the sidebar nav list
    const sidebarNavButtons = page.locator('nav[data-sidebar="sidebar"] button, [data-sidebar="menu"] button');
    const count = await sidebarNavButtons.count();
    if (count >= 3) {
      await sidebarNavButtons.nth(2).click();
    } else {
      // Last resort: navigate to /dock/shell/new_terminal via React Router push
      // (keeps existing sessions, unlike page.goto which reloads)
      await page.evaluate(() => {
        window.location.assign('/dock/shell/new_terminal');
      });
    }
  }

  // Wait for URL to include /dock/shell
  await page.waitForURL(/\/dock\/shell/, { timeout: 10_000 });

  // Wait for the terminal to be ready
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

/**
 * Type a command in the active xterm.js terminal and press Enter.
 * xterm.js uses a canvas-based renderer, so we interact via keyboard events.
 */
export async function sendCommand(page: Page, cmd: string) {
  // Click the terminal panel to ensure it has focus.
  // Use force:true so Playwright skips the pointer-intercept check — multiple sessions can stack
  // in the DOM when previous test runs left sessions open. The browser will correctly route
  // the click event to the topmost (most recently created) active panel.
  const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]').last();
  // Soft wait: ensure at least one terminal panel is present before clicking.
  // After page load or resize, useEntitiesQuery briefly re-subscribes (sessions=[]), causing
  // data-active="true" to be absent and panels to briefly unmount. We use 'attached' state
  // (DOM presence, not CSS visibility) so rapid command loops don't stall when React is
  // mid-re-render. The force:true click below handles any remaining visibility issues.
  await page
    .locator('[data-testid="terminal-panel"]')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });
  await terminalPanel.click({ force: true });

  // Small delay to ensure focus is set
  await page.waitForTimeout(200);

  // Type the command character by character (xterm.js needs keyboard events)
  await page.keyboard.type(cmd, { delay: 30 });
  await page.keyboard.press('Enter');
}

/**
 * Wait for specific text to appear in the terminal output.
 * xterm.js renders into .xterm-rows which contains the text content.
 * We poll until the text appears.
 */
export async function waitForOutput(page: Page, text: string, timeout = 15_000) {
  // First ensure the active panel exists (guards against brief re-render gaps on load/resize).
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });
  await expect(async () => {
    const content = await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .textContent();
    expect(content).toContain(text);
  }).toPass({ timeout });
}

/**
 * Click the "+" tab opener menu and pick a row by opener id.
 * Pinned-opener inline buttons (opener-inline-<id>, open-terminal-tab-button)
 * only render when the opener has been pinned; the always-present affordance
 * is the plus button + dropdown menu row.
 */
export async function openTabViaMenu(page: Page, openerId: 'claude' | 'terminal' | 'sandbox' | 'docker' | 'history' | 'claude-resume-by-id') {
  const inline =
    openerId === 'terminal'
      ? page.locator('[data-testid="open-terminal-tab-button"]')
      : page.locator(`[data-testid="opener-inline-${openerId}"]`);
  if (await inline.isVisible({ timeout: 500 }).catch(() => false)) {
    await inline.click();
    return;
  }
  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator(`[data-testid="opener-menu-row-${openerId}"]`).click();
}

/**
 * Click the "+" button to add a new terminal tab.
 */
export async function addTerminalTab(page: Page) {
  await openTabViaMenu(page, 'terminal');
  // Wait for the new tab and terminal to initialise
  await page.waitForTimeout(1_000);
}

/**
 * Start a Claude session in the current shell view (creates a new agentic process).
 */
export async function startClaudeSession(page: Page) {
  await openTabViaMenu(page, 'claude');
}

/**
 * Get the name of the currently active terminal tab.
 */
export async function getActiveTabName(page: Page): Promise<string> {
  // Active tab has the border-primary class applied to the tab div itself
  const activeTab = page.locator('[data-testid^="tab-"].border-primary span').first();
  if (await activeTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const text = await activeTab.textContent();
    return text?.trim() || '';
  }

  // Fallback: look for the tab div that contains border-primary in its class
  const allTabs = page.locator('[data-testid^="tab-"]');
  const count = await allTabs.count();
  for (let i = 0; i < count; i++) {
    const tab = allTabs.nth(i);
    const cls = await tab.getAttribute('class');
    if (cls?.includes('border-primary')) {
      const text = await tab.locator('span').first().textContent();
      return text?.trim() || '';
    }
  }
  return '';
}

/**
 * Navigate to Home via the sidebar Home button (client-side React Router nav).
 * Selects by lucide icon class to avoid positional-index drift (Refresh/Inbox
 * shifted indices in the sidebar). Click-path is required because this
 * scenario verifies that no-reload nav preserves React state including active
 * xterm.js terminal sessions.
 */
export async function goHome(page: Page) {
  const homeSidebarBtn = page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)');
  await homeSidebarBtn.click();
  await page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first().waitFor({ state: 'visible', timeout: 15_000 });

  // Dismiss WelcomeModal / setup modal if it appears and blocks clicks
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skipForNow.click({ force: true });
    await page.waitForTimeout(500);
  }
  const skipButton = page.getByRole('button', { name: 'Skip' });
  if (await skipButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await skipButton.click({ force: true });
    await page.waitForTimeout(500);
  }
}

/**
 * Navigate to the Shell view via the sidebar Shell button (client-side React
 * Router nav). Selects by lucide icon class — Shell is in mainNavItems
 * (always visible), so no chevron hover is needed.
 */
export async function gotoShellView(page: Page) {
  const shellSidebarBtn = page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-message-square)');
  await shellSidebarBtn.click();
  await page.waitForURL(/\/dock\/shell/, { timeout: 10_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Click on a specific terminal tab by name.
 */
export async function clickTab(page: Page, tabName: string) {
  const tab = page.locator('[data-testid^="tab-"]').filter({ hasText: tabName });
  await tab.click();
  await page.waitForTimeout(500);
}

/** The ACTIVE terminal panel — multiple panels (one per open tab) stack in the DOM. */
export function activePanel(page: Page) {
  return page.locator('[data-testid="terminal-panel"][data-active="true"]');
}

/**
 * The side window container, scoped to the active panel: every open tab keeps
 * its terminal panel mounted, each with its own side-window container — an
 * unscoped locator resolves to 2+ elements and trips strict mode.
 */
export function getSideWindow(page: Page) {
  return activePanel(page).locator('.w-80.flex-col.border-l');
}

/**
 * Idempotently OPEN a side tab via its ribbon button. Ribbon buttons TOGGLE:
 * with a reused process, a tab left open by an earlier test would be CLOSED
 * by a blind click — check the tab strip first.
 */
export async function ensureSideTabOpen(page: Page, buttonIndex: number, tabLabel: string) {
  const tabStrip = getSideWindow(page).locator('.border-b').first();
  const already = await tabStrip.getByText(tabLabel, { exact: true }).isVisible({ timeout: 1_000 }).catch(() => false);
  if (!already) await activePanel(page).locator('.border-t .ml-auto button').nth(buttonIndex).click();
  await tabStrip.getByText(tabLabel, { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
}

/** Idempotently CLOSE a side tab (via its × button) so toggle tests start closed. */
export async function ensureSideTabClosed(page: Page, tabLabel: string) {
  const closeBtn = activePanel(page).locator(`button[aria-label="Close ${tabLabel}"]`);
  if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeBtn.click();
    await closeBtn.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
  }
}
