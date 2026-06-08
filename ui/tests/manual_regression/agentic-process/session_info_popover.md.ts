/**
 * Session Info popover — gating, row presence, copy confirmation, command row.
 * Source: session_info_popover.md
 *
 * The popover (SessionInfoPopover in ProcessToolbar.tsx) renders only when
 * hasSession is true. Each row is a flex div: <span>{label}</span>
 * <button title="Click to copy">{value}</button>. Clicking the value button
 * flips it to "Copied!" for ~1.5s. The Command row reflects current CLI flags.
 */
import { test, expect, type Page } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, activePanel, sessionPopover } from './_ap_helpers';

const popover = sessionPopover;

// The row div = the parent of the label span. Value button is inside it.
function rowValueButton(page: Page, label: RegExp) {
  return popover(page).getByText(label).locator('xpath=..').locator('button[title="Click to copy"]');
}

async function openInfo(page: Page) {
  await activePanel(page).locator('button[aria-label$="session info"]').click();
  await expect(popover(page)).toBeVisible({ timeout: 10_000 });
}

// Grant clipboard so CopyRow's navigator.clipboard.writeText resolves (the
// transient "Copied!" only renders on a successful write).
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('session info popover', () => {
  test('test 1: Info popover gated on hasSession; shows all expected rows', async ({ page }) => {
    test.setTimeout(150_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);

    // Plain shell, no Claude session: the toolbar has no Info button.
    expect(await page.locator('button[aria-label$="session info"]').count()).toBe(0);

    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    await openInfo(page);

    // Labels rendered verbatim by SessionInfoPopover (Session ID / Session Name
    // carry a worker prefix → match on suffix).
    const exact = ['Process ID', 'Status', 'CLI worker status', 'Started', 'Last message',
      'Working Dir', 'PTY ID', 'Permission', 'Chrome', 'Debug', 'Worktree', 'Model', 'Command'];
    for (const label of exact) {
      await expect(popover(page).getByText(new RegExp(`^${label}$`)).first()).toBeVisible();
    }
    await expect(popover(page).getByText(/Session ID$/).first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(popover(page)).toHaveCount(0);
  });

  test('test 2: clicking a CopyRow shows transient "Copied!" confirmation', async ({ page }) => {
    test.setTimeout(150_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    await openInfo(page);
    const sessionIdBtn = rowValueButton(page, /Session ID$/);
    await sessionIdBtn.click();
    // Transient confirmation in the same button.
    await expect(sessionIdBtn.getByText('Copied!')).toBeVisible({ timeout: 2_000 });
    // Reverts to the value within ~1.5s.
    await expect(sessionIdBtn.getByText('Copied!')).toHaveCount(0, { timeout: 3_000 });
  });

  test('test 3: Command row reflects CLI flags (--chrome appears after toggle)', async ({ page }) => {
    test.setTimeout(150_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    await openInfo(page);
    const cmd = rowValueButton(page, /^Command$/);
    await expect(cmd).toContainText('claude');
    await expect(cmd).toContainText('--resume');
    await expect(cmd).not.toContainText('--chrome');
    await page.keyboard.press('Escape');
    await expect(popover(page)).toHaveCount(0);

    // Toggle Chrome ON via CLI Options dropdown (persists to entity on toggle).
    await activePanel(page).locator('button[aria-label="CLI Options"]').click();
    await page.getByRole('menuitemcheckbox', { name: /Chrome browser/ }).click();
    await page.keyboard.press('Escape');

    await openInfo(page);
    await expect(rowValueButton(page, /^Command$/)).toContainText('--chrome', { timeout: 10_000 });
    await expect(rowValueButton(page, /^Chrome$/)).toHaveText('enabled');
  });
});
