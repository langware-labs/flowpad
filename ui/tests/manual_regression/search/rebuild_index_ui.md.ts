import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { waitForIndexerIdle, apiBase } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';
import { adjusted } from '../../adjustableTimeout';

const API = apiBase();

// Poll the backend's authoritative activity-status until the indexer is idle
// (data === null). Bounded so it never silently rides past the per-test cap.

// Rebuild-index UI in the search view. The rebuild is explicit-click-only.
//
// SCOPE NOTE: this file encodes the tests that fit the per-category 60s config
// cap and do not depend on a FULL rebuild completing (which on a non-trivial
// corpus runs right at/over 60s — see the .md tests 6/7/9/11 budgets of
// 120-180s). We do NOT raise the cap to ride past a slow rebuild. Encoded here:
//   1  rebuild button visible in the header
//   2  clicking rebuild does NOT auto-open the activity modal
//   3  the search view's activity strip shows a phase during a rebuild
//   8  refreshing mid-rebuild restores the indicator without opening the modal
// Tests 6/7/9/11 (full-completion timing) and 5 (modal open) are completion- or
// budget-bound; test 10 needs WS-drop simulation. They are flagged to the
// manager rather than encoded against a cap they'd need raised to pass.

async function openSearch(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
  // The progress readout for a rebuild is the search view's own activity strip
  // (ActivityIndicator variant="strip", under the search bar). It needs no mode:
  // a page carries no view mode since 5a67651f9, and the old footer indicator is
  // gone from /dock/search.
  await page.goto('/dock/search');
  await page.locator('html[data-view]').waitFor({ timeout: adjusted(10_000) });
}

const rebuildBtn = (page: Page) => page.locator('[data-testid="rebuild-index"]');
const activityStrip = (page: Page) => page.locator('[data-testid="search-view"] [data-testid="activity-indicator-strip"]');
const ACTIVE_PHASE = /^(Archiving|Clearing|Scanning|Indexing)/;

// The strip renders only while an activity runs; read its text and decide by phase.
async function indicatorText(page: Page): Promise<string> {
  const el = activityStrip(page);
  if (!(await el.isVisible().catch(() => false))) return '';
  return (await el.innerText().catch(() => '')).trim();
}

test.describe('Search — rebuild-index UI', () => {
  test('1: rebuild-index button is visible in the search-view header', async ({ page }) => {
    await openSearch(page);
    await expect(page.locator('[data-testid="search-view"]')).toBeVisible({ timeout: adjusted(15_000) });
    const btn = rebuildBtn(page);
    await expect(btn).toBeVisible();
    // It wraps a PackageSearch (lucide-package-search) glyph.
    await expect(btn.locator('svg.lucide-package-search')).toHaveCount(1);
    // Tooltip on hover.
    await btn.hover();
    await expect(page.getByText('Refresh search data', { exact: false })).toBeVisible({ timeout: adjusted(5_000) });
  });

  test('2: clicking rebuild does NOT auto-open the activity progress modal', async ({ page }) => {
    await openSearch(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await rebuildBtn(page).click();
    await page.waitForTimeout(1_000);
    expect(await page.getByRole('dialog').count(), 'modal must NOT auto-open on rebuild click').toBe(0);
  });

  test('3: the search view activity strip shows an active phase during a rebuild', async ({ page, request }) => {
    // Drain any in-flight rebuild so the baseline is genuinely idle.
    await waitForIndexerIdle(request);
    await openSearch(page);
    // Idle baseline: the strip is absent (nothing is running).
    expect(ACTIVE_PHASE.test(await indicatorText(page)), 'no active phase at idle baseline').toBe(false);
    await rebuildBtn(page).click();
    // A rebuild flips the indicator text to an active phase.
    await expect
      .poll(() => indicatorText(page), { timeout: adjusted(5_000) })
      .toMatch(ACTIVE_PHASE);
  });

  test('8: refreshing after a rebuild click does not auto-open the modal', async ({ page, request }) => {
    // Drain any in-flight rebuild so this test's own rebuild is the one observed.
    await waitForIndexerIdle(request);
    await openSearch(page);
    await rebuildBtn(page).click();
    // Confirm the rebuild actually started (active phase), then reload right away.
    await expect.poll(() => indicatorText(page), { timeout: adjusted(5_000) }).toMatch(ACTIVE_PHASE);

    // Reload — whether the rebuild is still running or just finished, the modal
    // must NOT auto-open on load. (The rebuild duration is corpus-dependent and
    // may complete during the reload; the load-time invariant is the modal stays
    // closed and any indicator state is restored from /activity-status, not a
    // popped dialog.) This is the actual regression this test guards.
    await page.reload();
    await page.waitForLoadState('networkidle', { timeout: adjusted(20_000) }).catch(() => {});
    await page.waitForTimeout(1_000);
    expect(await page.getByRole('dialog').count(), 'no modal auto-opens after refresh').toBe(0);
    // NOTE: the manual-open-dialog tail (clicking the strip to open the progress
    // modal) only holds while a job is ACTIVE; on this corpus the rebuild often
    // completes during the reload, leaving the idle "indexed Nm ago" surface
    // which has no progress dialog to open. That tail is therefore timing-bound
    // and is flagged to the manager rather than asserted here. The deterministic,
    // load-time invariant — the modal must NOT auto-open after a refresh — is the
    // regression this test guards and is asserted above.
  });
});
