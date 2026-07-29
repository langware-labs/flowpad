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
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

interface BackendTabRow {
  id: string;
  pointer: string;
  tab_order: number;
  visible: boolean;
}

interface StoredDockPointer {
  tabHash?: string;
  viewType?: string;
  pointer?: string;
}

interface BootstrapData {
  default_project?: string | { id?: string };
}

async function defaultProjectId(api: APIRequestContext): Promise<string> {
  const response = await api.get(`${apiBase()}/api/v1/graph/bootstrap`);
  const body = await response.json();
  const project = (body.data as BootstrapData | undefined)?.default_project;
  const id = typeof project === 'string' ? project : project?.id;
  if (!id) throw new Error('bootstrap did not provide a default project');
  return id;
}

function projectDock(path: string, projectId: string): string {
  const url = new URL(withViewMode(path, 'advanced'), 'http://flowpad.test');
  url.searchParams.set('scope-mode', 'project');
  url.searchParams.set('scope-activeProjectId', projectId);
  return `${url.pathname}${url.search}`;
}

/** All visible Tab rows (pointer + global tab_order) straight from the backend
 *  (the same visible=true query the strip's source is built from). */
const VISIBLE_Q =
  '/api/v1/graph/tab?filter%5Bmatch%5D%5Bop%5D=%24EQ' +
  '&filter%5Bmatch%5D%5Boperands%5D%5B0%5D=visible' +
  '&filter%5Bmatch%5D%5Boperands%5D%5B1%5D=true';
async function backendTabs(
  api: APIRequestContext,
): Promise<Array<{ id: string; pointer: string; order: number }>> {
  const response = await api.get(`${apiBase()}${VISIBLE_Q}`);
  const res = await response.json();
  // Tab.pointer is the DockPointer JSON (`{"viewType","pointer"}`) for tabs
  // minted post-refactor, or the legacy opaque `viewType|pointer` string.
  // Normalize both to the `viewType|pointer` tabHash form (what the chips'
  // `data-terminal-target` carries) so DOM and backend compare on one key.
  const toHash = (p: string): string => {
    if (p && p.startsWith('{')) {
      try {
        const o = JSON.parse(p) as StoredDockPointer;
        return o.tabHash ?? `${o.viewType ?? ""}|${o.pointer ?? ""}`;
      } catch {
        return p;
      }
    }
    return p;
  };
  return ((res.data || []) as BackendTabRow[])
    .filter((tab) => tab.visible)
    .map((tab) => ({ id: tab.id, pointer: toHash(tab.pointer), order: tab.tab_order }));
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
    });
  });

  test('a real mouse drag reorders the strip and persists tab_order', async ({ page }) => {
    const api = await apiContext();
    try {
      const projectId = await defaultProjectId(api);
      const assetsPtr = `assets|project:${projectId}`;
      const filesPtr = `explorer|project:${projectId}`;

      // Clean slate: soft-close every existing visible tab so positions/order
      // are deterministic (this instance carries tabs from prior sessions).
      await page.goto(projectDock('/dock/assets', projectId));
      for (const tab of await backendTabs(api)) {
        await api.post(`${apiBase()}/api/v1/graph/tab/${tab.id}/close`);
      }

      // Two co-rendering project content tabs. Projectless Search intentionally
      // belongs to the Global strip and is not a valid same-strip fixture.
      await page.goto(projectDock('/dock/assets', projectId));
      await expect(page.locator(`[data-terminal-target="${assetsPtr}"]`)).toBeVisible({ timeout: 15_000 });
      await page.goto(projectDock('/dock/explorer', projectId));
      const assets = page.locator(`[data-terminal-target="${assetsPtr}"]`);
      const files = page.locator(`[data-terminal-target="${filesPtr}"]`);
      await expect(assets).toBeVisible({ timeout: 15_000 });
      await expect(files).toBeVisible({ timeout: 15_000 });

      // Order-agnostic: read the rendered order, then drag the RIGHT chip to the
      // front and assert it lands before the (former) left chip — DOM and backend.
      const before = await domOrder(page);
      const ai = before.indexOf(assetsPtr);
      const fi = before.indexOf(filesPtr);
      const leftPtr = ai < fi ? assetsPtr : filesPtr;
      const rightPtr = ai < fi ? filesPtr : assetsPtr;
      const left = page.locator(`[data-terminal-target="${leftPtr}"]`);
      const right = page.locator(`[data-terminal-target="${rightPtr}"]`);

      // Backend baseline agrees with the DOM (single source of truth).
      const beBefore = await backendTabs(api);
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
        const rows = await backendTabs(api);
        expect(rows.find((t) => t.pointer === rightPtr)!.order).toBeLessThan(
          rows.find((t) => t.pointer === leftPtr)!.order,
        );
      }).toPass({ timeout: 5_000 });

      // Persistence survives a reload (the strip rebuilds from Tab.list, same order).
      await page.goto(projectDock('/dock/explorer', projectId));
      await expect(async () => {
        const after = await domOrder(page);
        expect(after.indexOf(rightPtr)).toBeLessThan(after.indexOf(leftPtr));
      }).toPass({ timeout: 10_000 });
    } finally {
      await api.dispose();
    }
  });
});
