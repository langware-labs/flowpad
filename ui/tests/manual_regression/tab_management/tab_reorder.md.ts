/**
 * Tab Management — drag reorder + backend persistence (debugMcp / live stack).
 *
 * Proves the backend-authoritative ordering end-to-end with a REAL mouse drag
 * (Playwright dispatches genuine pointerdown/move/up — the CDP `computer` tool
 * does not, so this is the only faithful drag driver):
 *
 *   open two tabs → read order → drag one past the other → the strip repaints in
 *   the predicted order AND the backend `Tab.tab_order` rows persist the new order.
 *
 * Every chip is keyed by its pointer (== DockPointer.tabHash); the strip renders
 * exactly the backend list, so DOM order and `tab_order` must agree after a drag.
 * Assumes backend + frontend are running (VITE_PORT points at the instance).
 */
import { test, expect, type Page } from '@playwright/test';

/** All visible Tab rows (pointer + global tab_order) straight from the backend
 *  (the same visible=true query the strip's source is built from). */
const VISIBLE_Q =
  '/api/v1/graph/tab?filter%5Bmatch%5D%5Bop%5D=%24EQ' +
  '&filter%5Bmatch%5D%5Boperands%5D%5B0%5D=visible' +
  '&filter%5Bmatch%5D%5Boperands%5D%5B1%5D=true';
async function backendTabs(page: Page): Promise<Array<{ pointer: string; order: number }>> {
  return page.evaluate(async (q) => {
    const res = await fetch(q).then((r) => r.json());
    return (res.data || [])
      .filter((t: any) => t.visible)
      .map((t: any) => ({ pointer: t.pointer, order: t.tab_order }));
  }, VISIBLE_Q);
}

/** DOM chip order (the rendered strip), top-level pointers in left→right order. */
async function domOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="terminal-tab-bar"] [data-terminal-target]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-terminal-target') || ''));
}

test.describe('Tab Management — drag reorder persists to the backend', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
      localStorage.setItem('viewMode', 'advanced');
    });
  });

  test('a real mouse drag reorders the strip and persists tab_order', async ({ page }) => {
    // Clean slate: soft-close every existing visible tab so positions/order are
    // deterministic (this instance carries tabs from prior sessions).
    await page.goto('/dock/assets');
    await page.evaluate(async (q) => {
      const res = await fetch(q).then((r) => r.json());
      for (const t of (res.data || []).filter((x: any) => x.visible)) {
        await fetch(`/api/v1/graph/tab/${t.id}/close`, { method: 'POST' });
      }
    }, VISIBLE_Q);

    // Two co-rendering, project-scoped tabs: Assets (content) + Shell (terminal).
    await page.goto('/dock/assets');
    await expect(page.locator('[data-terminal-target="assets|"]')).toBeVisible({ timeout: 15_000 });
    await page.goto('/dock/shell');
    const assets = page.locator('[data-terminal-target="assets|"]');
    const shell = page.locator('[data-terminal-target="shell|"]');
    await expect(assets).toBeVisible({ timeout: 15_000 });
    await expect(shell).toBeVisible({ timeout: 15_000 });

    // Order-agnostic: read the rendered order, then drag the RIGHT chip to the
    // front and assert it lands before the (former) left chip — DOM and backend.
    const before = await domOrder(page);
    const ai = before.indexOf('assets|');
    const si = before.indexOf('shell|');
    const leftPtr = ai < si ? 'assets|' : 'shell|';
    const rightPtr = ai < si ? 'shell|' : 'assets|';
    const left = page.locator(`[data-terminal-target="${leftPtr}"]`);
    const right = page.locator(`[data-terminal-target="${rightPtr}"]`);

    // Backend baseline agrees with the DOM (single source of truth).
    const beBefore = await backendTabs(page);
    expect(beBefore.find((t) => t.pointer === leftPtr)!.order).toBeLessThan(
      beBefore.find((t) => t.pointer === rightPtr)!.order,
    );

    // REAL drag: pick up the right chip, drop it left of the left chip's midpoint.
    const rb = (await right.boundingBox())!;
    const lb = (await left.boundingBox())!;
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 8 });
    await page.mouse.move(lb.x + 2, lb.y + lb.height / 2, { steps: 4 });
    await page.mouse.up();

    // Strip repaints with the dragged chip first…
    await expect(async () => {
      const after = await domOrder(page);
      expect(after.indexOf(rightPtr)).toBeLessThan(after.indexOf(leftPtr));
    }).toPass({ timeout: 5_000 });

    // …and the backend persisted the new order (dragged.tab_order < other).
    await expect(async () => {
      const rows = await backendTabs(page);
      expect(rows.find((t) => t.pointer === rightPtr)!.order).toBeLessThan(
        rows.find((t) => t.pointer === leftPtr)!.order,
      );
    }).toPass({ timeout: 5_000 });

    // Persistence survives a reload (the strip rebuilds from Tab.list, same order).
    await page.goto('/dock/shell');
    await expect(async () => {
      const after = await domOrder(page);
      expect(after.indexOf(rightPtr)).toBeLessThan(after.indexOf(leftPtr));
    }).toPass({ timeout: 10_000 });
  });
});
