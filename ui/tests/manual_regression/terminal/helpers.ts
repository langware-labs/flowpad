import { type Page, expect } from '@playwright/test';

/**
 * Dismiss the DesktopSetupModal if it appears.
 * Sets localStorage key before page loads so the modal never shows.
 */
export async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
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
  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

  // Wait for the terminal panels container to be visible
  // Increased to 30s: with many accumulated shell sessions the page takes longer to initialize.
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });

  // Wait for xterm.js to initialise inside the active panel
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });

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
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });
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
  await expect(async () => {
    const content = await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .textContent();
    expect(content).toContain(text);
  }).toPass({ timeout });
}

/**
 * Click the "+" button to add a new terminal tab.
 */
export async function addTerminalTab(page: Page) {
  const addButton = page.locator('[data-testid="open-terminal-tab-button"]');
  await addButton.click();
  // Wait for the new tab and terminal to initialise
  await page.waitForTimeout(1_000);
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
 * The sidebar buttons have no title/label, so we use positional selection:
 *   [data-sidebar="menu-button"] nth 1 = Home (after Back at nth 0)
 * This preserves React state including active terminal sessions.
 */
export async function goHome(page: Page) {
  // The collapsed sidebar renders: Back(0), Home(1), Shell(2), Skills(3), Triggers(4), …
  const homeSidebarBtn = page.locator('[data-sidebar="menu-button"]').nth(1);
  await homeSidebarBtn.click();
  await page.getByRole('heading', { name: /hey /i }).waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Navigate to the Shell view via the sidebar Shell button (client-side React Router nav).
 * [data-sidebar="menu-button"] nth 2 = Shell.
 */
export async function gotoShellView(page: Page) {
  const shellSidebarBtn = page.locator('[data-sidebar="menu-button"]').nth(2);
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
