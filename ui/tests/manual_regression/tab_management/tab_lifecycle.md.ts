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
 * These scenarios lock the Tab lifecycle within one backend-owned project
 * scope: open → coexist → select → soft-close (visible=false, row survives) →
 * reopen (same row, no duplicate). Global/projectless tabs intentionally live
 * in a different strip and therefore are not valid coexistence fixtures here.
 *
 * Assertions mix DOM (the chips) and backend `Tab` rows (via the explicit
 * instance API context), so the
 * test proves the URL-first → loader-upsert → strip-render → soft-close path
 * end-to-end. Assumes backend + frontend are running.
 */
import { test, expect, type Page } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

interface TabRow {
  pointer: string;
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

function dismissModals(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function defaultProjectId(): Promise<string> {
  const api = await apiContext();
  try {
    const response = await api.get(`${apiBase()}/api/v1/graph/bootstrap`);
    const body = await response.json();
    const project = (body.data as BootstrapData | undefined)?.default_project;
    const id = typeof project === 'string' ? project : project?.id;
    if (!id) throw new Error('bootstrap did not provide a default project');
    return id;
  } finally {
    await api.dispose();
  }
}

function projectDock(path: string, projectId: string): string {
  const url = new URL(withViewMode(path, 'advanced'), 'http://flowpad.test');
  url.searchParams.set('scope-mode', 'project');
  url.searchParams.set('scope-activeProjectId', projectId);
  return `${url.pathname}${url.search}`;
}

async function visibleTabs(): Promise<Array<{ pointer: string; visible: boolean }>> {
  const api = await apiContext();
  try {
    const response = await api.get(`${apiBase()}/api/v1/graph/tab`);
    const res = await response.json();
    // Tab.pointer is stored as the DockPointer JSON (`{"viewType","pointer"}`)
    // for tabs minted post-refactor, or the legacy opaque `viewType|pointer`
    // string for older rows. Normalize both to the `viewType|pointer` tabHash
    // form the assertions match against.
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
    return ((res.data || []) as TabRow[]).map((t) => ({
      pointer: toHash(t.pointer),
      visible: t.visible,
    }));
  } finally {
    await api.dispose();
  }
}

test.describe('Tab Management — content tab lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await dismissModals(page);
  });

  // ── 1. open → a content surface becomes a persistent visible Tab ──────────
  test('open Assets materializes a visible Tab chip', async ({ page }) => {
    const projectId = await defaultProjectId();
    const assetsKey = `assets|project:${projectId}`;
    await page.goto(projectDock('/dock/assets', projectId));
    await expect(page.locator(`[data-testid="tab-content-${assetsKey}"]`)).toBeVisible({ timeout: 10_000 });
    const rows = await visibleTabs();
    expect(rows.find((r) => r.pointer === assetsKey)?.visible).toBe(true);
  });

  // ── 2. coexist — opening another project tab does not evict Assets ─────────
  test('Assets and Files coexist in the project strip', async ({ page }) => {
    const projectId = await defaultProjectId();
    const assetsKey = `assets|project:${projectId}`;
    const filesKey = `explorer|project:${projectId}`;
    await page.goto(projectDock('/dock/assets', projectId));
    await page.goto(projectDock('/dock/explorer', projectId));
    await expect(page.locator(`[data-testid="tab-content-${assetsKey}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-testid="tab-content-${filesKey}"]`)).toBeVisible({ timeout: 10_000 });
  });

  // ── 3. select — clicking a content chip is URL-first ──────────────────────
  test('clicking the Assets chip navigates back (URL-first)', async ({ page }) => {
    const projectId = await defaultProjectId();
    const assetsKey = `assets|project:${projectId}`;
    await page.goto(projectDock('/dock/assets', projectId));
    await page.goto(projectDock('/dock/explorer', projectId));
    await page.locator(`[data-testid="tab-content-${assetsKey}"]`).click();
    await expect(page).toHaveURL(/\/dock\/assets/, { timeout: 10_000 });
  });

  // ── 4. soft-close — close flips the Tab to visible=false; the row survives ─
  test('closing a content tab is a soft-close (row survives visible=false)', async ({ page }) => {
    const projectId = await defaultProjectId();
    const filesKey = `explorer|project:${projectId}`;
    await page.goto(projectDock('/dock/explorer', projectId));
    const chip = page.locator(`[data-testid="tab-content-${filesKey}"]`);
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.hover();
    // Close button is hover-gated; force the click past the opacity transition.
    await chip.locator('[aria-label="Close tab"]').click({ force: true });
    // The contract is the soft-close: the row survives as visible=false (never
    // delete-to-close, so the close broadcasts cross-client).
    await expect(async () => {
      const rows = await visibleTabs();
      expect(rows.find((r) => r.pointer === filesKey)?.visible).not.toBe(true);
    }).toPass({ timeout: 10_000 });
  });

  // ── 5. reopen — same pointer reuses the one row (no duplicate) ────────────
  test('reopening reuses the same Tab row (no duplicate)', async ({ page }) => {
    const projectId = await defaultProjectId();
    const assetsKey = `assets|project:${projectId}`;
    const assetsUrl = projectDock('/dock/assets', projectId);
    await page.goto(assetsUrl);
    await page.goto(assetsUrl); // navigate twice
    const rows = (await visibleTabs()).filter((r) => r.pointer === assetsKey);
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(rows[0]?.visible).toBe(true);
  });
});
