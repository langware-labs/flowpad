import { type Page, expect } from '@playwright/test';

/**
 * Pre-pin the terminal/sandbox/docker openers so their inline test ids render.
 * By default nothing is pinned, and the openers live inside a dropdown menu
 * which is not directly selectable by test id.
 */
export async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'flowpad.terminal.pinnedOpeners',
      JSON.stringify(['terminal', 'sandbox', 'docker']),
    );
  });
}

/**
 * Navigate to the Shell view by going to /dock/shell/new_terminal.
 * This creates a fresh interactive PTY terminal and waits for it to be ready.
 */
export async function gotoShell(page: Page) {
  await page.goto('/dock/shell/new_terminal');

  // Wait for URL to settle (new_terminal redirects to /dock/shell/<sessionId>)
  await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });

  // Wait for the terminal panels container to be visible
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });

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
 * Hovers the secondary-nav chevron to expand it, then clicks the Shell button.
 */
export async function gotoShellViaSidebar(page: Page) {
  // Hover the chevron area to expand secondary nav items
  const chevronArea = page.locator('svg.lucide-chevron-down').first();
  await chevronArea.hover();

  // Wait for the Shell button to become visible (it animates in)
  const shellButton = page.getByRole('button', { name: 'Shell' });
  await shellButton.waitFor({ state: 'visible', timeout: 5_000 });
  await shellButton.click();

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
  // Click the terminal panel to ensure it has focus
  const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
  await terminalPanel.click();

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
 * Navigate to Home via the sidebar Home button (first button in sidebar nav).
 */
export async function goHome(page: Page) {
  // Direct navigation is more reliable than hunting the sidebar's first button,
  // whose DOM position drifts when secondary-nav items are added/removed.
  await page.goto('/');
  await page.getByRole('heading', { name: /hey /i }).waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Click on a specific terminal tab by name.
 */
export async function clickTab(page: Page, tabName: string) {
  const tab = page.locator('[data-testid^="tab-"]').filter({ hasText: tabName });
  await tab.click();
  await page.waitForTimeout(500);
}
