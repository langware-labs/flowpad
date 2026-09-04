import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';

import { apiBase } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

const API = apiBase();

async function createWhiteboard(request: APIRequestContext, name: string, projectId?: string) {
  const scopePath = projectId ? `/project/${projectId}` : '';
  const res = await request.post(`${API}/api/v1/graph${scopePath}/whiteboard`, { data: { name } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { id: body.data.id as string, assetRef: body.data.asset_ref as string };
}

async function pickProjectId(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${API}/api/v1/graph/project`);
  expect(res.status()).toBe(200);
  const projects = ((await res.json()).data || []) as Array<{
    id: string;
    fs_storage_mount_path?: string | null;
  }>;
  const project = projects.find((candidate) => candidate.fs_storage_mount_path);
  expect(project, 'a project with fs_storage_mount_path exists').toBeTruthy();
  return project.id;
}

async function openEditor(page: Page, id: string) {
  await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
  await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => typeof (window as any).__whiteboardApi === 'object' && (window as any).__whiteboardApi, null, {
    timeout: 15_000,
  });
}

// Open the whiteboard asset list with the sidebar tree showing whiteboard rows.
// Two setup facts the .md's "find a whiteboard row" step depends on:
//   1. Whiteboard is `browseable_by=advanced` (TypeInfo) — it only appears in
//      the Assets tree in Advanced view mode. The URL carries that mode so the
//      route loader remains the single writer of view state.
//   2. Navigating to `/dock/assets/list/<type>` deliberately does NOT auto-expand
//      the sidebar root (it avoids a duplicate /search of the right-panel list),
//      so the whiteboard rows only materialize after its chevron is expanded —
//      the same expand-if-collapsed pattern the agent asset-picker test uses.
async function openWhiteboardListExpanded(page: Page, projectId: string, whiteboardId: string) {
  const scopedList = withViewMode(
    `/dock/assets/list/whiteboard?scope-mode=project&scope-activeProjectId=${encodeURIComponent(projectId)}`,
    'advanced',
  );
  await page.goto(scopedList);
  await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-view')), { timeout: 10_000 })
    .toBe('advanced');
  const chevron = page.getByTestId('browseable-chevron-asset-type:whiteboard');
  await expect(chevron).toBeVisible({ timeout: 15_000 });
  const createdRow = page.locator(`[data-testid="browseable-toolbar-delete:whiteboard:${whiteboardId}"]`);
  if (!(await createdRow.isVisible({ timeout: 2_000 }).catch(() => false))) {
    await chevron.click();
  }
  await expect(createdRow).toBeVisible({ timeout: 15_000 });
  return createdRow;
}

test.describe('Whiteboard — UI / UX (U1–U4)', () => {
  test('U1: tree row carries a Palette icon', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
    const projectId = await pickProjectId(request);
    const { id, assetRef } = await createWhiteboard(
      request,
      `ui-u1-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      projectId,
    );
    const createdRow = await openWhiteboardListExpanded(page, projectId, id);

    // The created whiteboard row's leading icon is a lucide Palette glyph (the
    // whiteboard TypeInfo icon = 'Palette'). Walk from its delete
    // button up to the treeitem and inspect its non-trash svg.
    const hasPalette = await createdRow.evaluate((delBtn) => {
      let row: Element | null = delBtn ? delBtn.parentElement : null;
      for (let i = 0; i < 10 && row; i++) {
        const svgs = Array.from(row.querySelectorAll('svg')).map((s) => s.getAttribute('class') || '');
        if (svgs.some((c) => c.includes('lucide-palette'))) return true;
        row = row.parentElement;
      }
      return false;
    });
    expect(hasPalette, 'whiteboard row has a lucide-palette icon').toBe(true);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('U2: whiteboard list shows whiteboards only', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
    // Create in the same project scope the list route reads. Entity.store()
    // updates the searchable record before this POST returns.
    const projectId = await pickProjectId(request);
    const { id, assetRef } = await createWhiteboard(
      request,
      `ui-u2-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      projectId,
    );
    await openWhiteboardListExpanded(page, projectId, id);

    // On the whiteboard list path, the rendered rows are all whiteboards — no
    // skill/agent/markdown rows leak in.
    const counts = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[data-testid^="browseable-toolbar-delete:"]')).map((e) =>
        (e.getAttribute('data-testid') || '').split(':')[1],
      );
      const wb = all.filter((t) => t === 'whiteboard').length;
      const other = all.filter((t) => t !== 'whiteboard');
      return { total: all.length, wb, otherTypes: Array.from(new Set(other)) };
    });
    expect(counts.wb, 'at least one whiteboard row present').toBeGreaterThanOrEqual(1);
    expect(counts.otherTypes, `no non-whiteboard rows: ${counts.otherTypes.join(', ')}`).toHaveLength(0);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('U3: save debounce — five rapid updates coalesce into one write', async ({ page, request }) => {
    test.setTimeout(60_000);
    // The save goes through axios, which in the browser uses XMLHttpRequest
    // (NOT window.fetch). Hook XHR.open BEFORE the page loads to count board.json
    // write requests (POST). Counting actual requests with a before/after delta
    // around the burst is load-independent — no reliance on file-mtime timing.
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      (window as any).__wbWrites = 0;
      const open: XMLHttpRequest['open'] = Reflect.get(XMLHttpRequest.prototype, 'open');
      XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
        try {
          if (/board\.json/.test(String(url)) && String(method).toUpperCase() === 'POST') {
            (window as any).__wbWrites++;
          }
        } catch {
          /* ignore */
        }
        // @ts-expect-error variadic passthrough
        return open.call(this, method, url, ...rest);
      };
    });
    const { id, assetRef } = await createWhiteboard(request, `ui-u3-${Date.now() % 10000}`);
    await openEditor(page, id);

    // Let the finite burst of mount-phase writes settle (Excalidraw fires a
    // couple of init onChanges), then snapshot the write count.
    await page.waitForTimeout(5_000);
    const before = await page.evaluate(() => (window as any).__wbWrites as number);

    // Fire 5 onChange calls in rapid succession (each resets the 750ms debounce).
    for (let i = 0; i < 5; i++) {
      await page.evaluate((n) => {
        const lib = (window as any).__excalidrawLib;
        const api = (window as any).__whiteboardApi;
        api.updateScene({ elements: lib.convertToExcalidrawElements([{ type: 'rectangle', x: n * 20, y: 10, width: 40, height: 40, label: { text: `R${n}` } }]) });
        (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
      }, i);
      await page.waitForTimeout(80); // rapid, but < the 750ms debounce window
    }

    // Wait well past the debounce for the single coalesced write to land.
    await page.waitForTimeout(2_500);
    const after = await page.evaluate(() => (window as any).__wbWrites as number);
    expect(after - before, `5 rapid updates coalesce into exactly one board.json write (delta=${after - before})`).toBe(1);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('U4: pasted image lives in board.json data.files', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
    const { id, assetRef } = await createWhiteboard(request, `ui-u4-${Date.now() % 10000}`);
    await openEditor(page, id);

    // Add a 1x1 PNG as an excalidraw file + an image element referencing it.
    const dataURL = await page.evaluate(() => {
      const lib = (window as any).__excalidrawLib;
      const api = (window as any).__whiteboardApi;
      const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      api.addFiles([{ id: 'u4-file-1', dataURL: url, mimeType: 'image/png', created: Date.now() }]);
      const els = lib.convertToExcalidrawElements([{ type: 'image', x: 20, y: 20, width: 40, height: 40, fileId: 'u4-file-1' }]);
      api.updateScene({ elements: els });
      (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
      return url;
    });

    const boardPath = `${assetRef}/board.json`;
    let files: Record<string, any> = {};
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1_000);
      if (fs.existsSync(boardPath)) {
        const bj = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
        files = bj.data?.files || {};
        if (Object.keys(files).length > 0) break;
      }
    }
    const entries = Object.values(files);
    expect(entries.length, 'board.json data.files has an entry').toBeGreaterThanOrEqual(1);
    expect(entries.some((f: any) => typeof f?.dataURL === 'string' && f.dataURL === dataURL), 'data.files entry carries the dataURL').toBe(true);

    // Reload: image element still present, no error boundary.
    await openEditor(page, id);
    await page.waitForTimeout(1_500);
    const imgCount = await page.evaluate(() =>
      (window as any).__whiteboardApi.getSceneElements().filter((e: any) => e.type === 'image').length,
    );
    expect(imgCount, 'image element survives reload').toBeGreaterThanOrEqual(1);
    expect(await page.getByRole('heading', { name: /^Error$/ }).count()).toBe(0);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });
});
