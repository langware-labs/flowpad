/**
 * Terminal session persistence on refresh.
 * Source: session_persistence_on_refresh.md
 *
 * Covers every session-producing entry path from the source scenario with a
 * real page reload. The assertions use URL/session identity and rendered
 * terminal/workspace state; a navigation back to the shell root would not pass.
 */
import { expect, test, type Page } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';

async function prepare(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function openTerminal(page: Page) {
  await page.goto(withViewMode('/dock/shell/new_terminal', 'advanced'));
  await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
  await expect(
    page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first(),
  ).toBeAttached();
}

async function typeInActiveTerminal(page: Page, text: string) {
  await page.locator('[data-testid="terminal-panel"][data-active="true"]').last().click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('Terminal session persistence on refresh', () => {
  test.beforeEach(async ({ page }) => {
    await prepare(page);
  });

  test('pure terminal restores its URL, PTY surface, and output after reload', async ({ page }) => {
    await openTerminal(page);
    const terminalUrl = page.url();
    const marker = `refresh-pure-${Date.now()}`;

    await typeInActiveTerminal(page, `echo ${marker}`);
    await expect(
      page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first(),
    ).toContainText(marker);

    await page.reload();

    expect(page.url()).toBe(terminalUrl);
    await expect(
      page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first(),
    ).toContainText(marker);
    await expect(page.getByText('No terminal sessions')).toHaveCount(0);
  });

  test('Start Claude session reconnects to the same process after reload', async ({ page }) => {
    await openTerminal(page);
    await page.getByTestId('opener-plus-button').click();
    await page.getByTestId('opener-menu-row-claude').click();
    await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-(?!new)/);
    const processUrl = page.url();

    await expect(page.getByTestId('terminal-panels')).toBeVisible();
    await page.reload();

    expect(page.url()).toBe(processUrl);
    await expect(page.getByTestId('terminal-panels')).toBeVisible();
    await expect(page.getByText('No terminal sessions')).toHaveCount(0);
  });

  test('home prompt restores the same Vibe session rather than an empty shell', async ({ page }) => {
    await page.goto('/dock/home');
    const input = page.locator('textarea[aria-label="What would you like to work on?"]');
    await expect(input).toBeVisible();
    await input.fill('reply with single word - hello');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-/);
    const processUrl = page.url();
    await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();

    await page.reload();

    expect(page.url()).toBe(processUrl);
    await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
    await expect(page.getByText('No terminal sessions')).toHaveCount(0);
  });

  test('a closed terminal stays closed after reload', async ({ page }) => {
    await openTerminal(page);
    const activeTab = page.locator('[data-testid^="tab-"][data-active="true"]').first();
    const tabTestId = await activeTab.getAttribute('data-testid');
    expect(tabTestId).toBeTruthy();

    await activeTab.hover();
    await activeTab.getByRole('button', { name: 'Close tab' }).click();
    await expect(page.locator(`[data-testid="${tabTestId}"]`)).toHaveCount(0);

    await page.reload();
    await expect(page.locator(`[data-testid="${tabTestId}"]`)).toHaveCount(0);
  });
});
