/**
 * Session Info popover — gating, row presence, copy confirmation, command row.
 * Source: session_info_popover.md
 *
 * The popover (SessionInfoPopover in ProcessToolbar.tsx) renders only when
 * hasSession is true. Each CopyRow is a flex div: <span>{label}</span>
 * <span>{value}</span> <button aria-label="Copy {label}">. Clicking the copy
 * button swaps its icon to a green check for ~1.5s (no "Copied!" text since
 * the CopyRow redesign). The Command row reflects current CLI flags.
 */
import { test, expect, type Page } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, startClaude, processIdFromUrl, waitForRunningSession, apiBase, activePanel, sessionPopover } from './_ap_helpers';

const popover = sessionPopover;

// The row div = the parent of the label span (CopyRow's .group flex).
function row(page: Page, label: RegExp) {
  return popover(page).getByText(label).locator('xpath=..');
}
// Value lives in the flex-1 mono span (no longer a button).
function rowValue(page: Page, label: RegExp) {
  return row(page, label).locator('span.flex-1');
}
// Per-row copy button: aria-label="Copy <label>"; confirmation = check icon.
function rowCopyButton(page: Page, label: RegExp) {
  return row(page, label).locator('button[aria-label^="Copy"]');
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
    test.setTimeout(60_000);
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
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    await openInfo(page);
    const copyBtn = rowCopyButton(page, /Session ID$/);
    await copyBtn.click();
    // Transient confirmation: the copy icon swaps to a green check for ~1.5s.
    await expect(copyBtn.locator('svg.lucide-check')).toBeVisible({ timeout: 2_000 });
    // Reverts to the copy icon.
    await expect(copyBtn.locator('svg.lucide-check')).toHaveCount(0, { timeout: 3_000 });
  });

  test('test 3: Command row reflects CLI flags (--chrome appears after toggle)', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);
    await gotoNewShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    await waitForRunningSession(page, apiBase(), pid);

    await openInfo(page);
    const cmd = rowValue(page, /^Command$/);
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
    await expect(rowValue(page, /^Command$/)).toContainText('--chrome', { timeout: 10_000 });
    await expect(rowValue(page, /^Chrome$/)).toHaveText('enabled');
  });
});
