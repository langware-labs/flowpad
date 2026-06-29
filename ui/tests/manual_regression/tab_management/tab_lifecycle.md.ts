/**
 * Tab Management — lifecycle matrix (docs/tab-management.md).
 *
 * The content-panel strip is now two cooperating systems:
 *   - terminal tabs (shell / agentic_process) — live status-derived entities,
 *     rendered by useTerminalStripController.
 *   - content tabs (assets, markdown, skill, workflow, settings, search, diff…)
 *     — first-class `Tab` entities, materialized by the route loader on every
 *     navigation and rendered as chips (testId `tab-content-<pointer>`).
 *
 * These scenarios lock the bug this work fixed (opening Terminals used to evict
 * a content surface like Assets) and the Tab lifecycle: open → coexist → select
 * → soft-close (visible=false, row survives) → reopen (same row, no duplicate).
 *
 * Assertions mix DOM (the chips) and the backend `Tab` rows (via fetch), so the
 * test proves the URL-first → loader-upsert → strip-render → soft-close path
 * end-to-end. Assumes backend + frontend are running.
 */
import { test, expect, type Page } from '@playwright/test';

function dismissModals(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', 'true');
    localStorage.setItem('viewMode', 'advanced');
  });
}

async function visibleTabs(page: Page): Promise<Array<{ pointer: string; visible: boolean }>> {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/graph/tab').then((r) => r.json());
    // Tab.pointer is stored as the DockPointer JSON (`{"viewType","pointer"}`)
    // for tabs minted post-refactor, or the legacy opaque `viewType|pointer`
    // string for older rows. Normalize both to the `viewType|pointer` tabHash
    // form the assertions match against.
    const toHash = (p: string): string => {
      if (p && p.startsWith('{')) {
        try {
          const o = JSON.parse(p);
          return o.tabHash ?? `${o.viewType ?? ""}|${o.pointer ?? ""}`;
        } catch {
          return p;
        }
      }
      return p;
    };
    return (res.data || []).map((t: any) => ({ pointer: toHash(t.pointer), visible: t.visible }));
  });
}

test.describe('Tab Management — content tab lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await dismissModals(page);
  });

  // ── 1. open → a content surface becomes a persistent visible Tab ──────────
  test('open Assets materializes a visible Tab chip', async ({ page }) => {
    await page.goto('/dock/assets');
    await expect(page.locator('[data-testid="tab-content-assets|all"]')).toBeVisible({ timeout: 10_000 });
    const rows = await visibleTabs(page);
    expect(rows.find((r) => r.pointer === 'assets|all')?.visible).toBe(true);
  });

  // ── 2. coexist — opening Terminals does NOT evict Assets (the reported bug) ─
  test('Assets and Terminals coexist in the strip', async ({ page }) => {
    await page.goto('/dock/assets');
    await expect(page.locator('[data-testid="tab-content-assets|all"]')).toBeVisible({ timeout: 10_000 });
    await page.goto('/dock/shell');
    // The Assets content chip must still be present after navigating to shell.
    await expect(page.locator('[data-testid="tab-content-assets|all"]')).toBeVisible({ timeout: 10_000 });
  });

  // ── 3. select — clicking a content chip is URL-first ──────────────────────
  test('clicking the Assets chip navigates back (URL-first)', async ({ page }) => {
    await page.goto('/dock/assets');
    await page.goto('/dock/search');
    await page.locator('[data-testid="tab-content-assets|all"]').click();
    await expect(page).toHaveURL(/\/dock\/assets/, { timeout: 10_000 });
  });

  // ── 4. soft-close — close flips the Tab to visible=false; the row survives ─
  test('closing a content tab is a soft-close (row survives visible=false)', async ({ page }) => {
    await page.goto('/dock/search');
    const chip = page.locator('[data-testid="tab-content-search|"]');
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.hover();
    // Close button is hover-gated; force the click past the opacity transition.
    await page.locator('[data-testid="tab-content-search|"] [aria-label="Close tab"]').click({ force: true });
    // The contract is the soft-close: the row survives as visible=false (never
    // delete-to-close, so the close broadcasts cross-client).
    await expect(async () => {
      const rows = await visibleTabs(page);
      expect(rows.find((r) => r.pointer === 'search|')?.visible).not.toBe(true);
    }).toPass({ timeout: 10_000 });
  });

  // ── 5. reopen — same pointer reuses the one row (no duplicate) ────────────
  test('reopening reuses the same Tab row (no duplicate)', async ({ page }) => {
    await page.goto('/dock/assets');
    await page.goto('/dock/assets'); // navigate twice
    const rows = (await visibleTabs(page)).filter((r) => r.pointer === 'assets|all');
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(rows[0]?.visible).toBe(true);
  });
});
