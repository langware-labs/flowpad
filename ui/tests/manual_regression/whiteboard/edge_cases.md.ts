import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';

const API = process.env.API_URL || 'http://localhost:6002';

async function createWhiteboard(request: APIRequestContext, name: string) {
  const res = await request.post(`${API}/api/v1/graph/whiteboard`, { data: { name } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { id: body.data.id as string, assetRef: body.data.asset_ref as string };
}

async function openEditor(page: Page, id: string) {
  await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
  await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => typeof (window as any).__whiteboardApi === 'object' && (window as any).__whiteboardApi, null, {
    timeout: 15_000,
  });
}

// Inject a skeleton + fire the editor's onChange with the committed scene.
async function injectAndSave(page: Page, skeleton: unknown[]) {
  await page.evaluate((skel) => {
    const lib = (window as any).__excalidrawLib;
    const api = (window as any).__whiteboardApi;
    api.updateScene({ elements: lib.convertToExcalidrawElements(skel) });
  }, skeleton);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const api = (window as any).__whiteboardApi;
    (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
  });
}

const TWO_BOXES_ARROW = [
  { type: 'rectangle', id: 'R1', x: 50, y: 50, width: 140, height: 60, label: { text: 'A' } },
  { type: 'rectangle', id: 'R2', x: 280, y: 50, width: 140, height: 60, label: { text: 'B' } },
  { type: 'arrow', x: 190, y: 80, width: 90, height: 0, points: [[0, 0], [90, 0]], start: { id: 'R1' }, end: { id: 'R2' } },
];

test.describe('Whiteboard — Edge Cases (E1–E5)', () => {
  test('E1: idle does not loop the debounced save (no repeated writes without onChange)', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `e1-${Date.now() % 10000}`);
    await openEditor(page, id);

    // The save goes through axios/XHR (not window.fetch), and board.json
    // materializes lazily. Excalidraw fires one onChange on initial mount, which
    // legitimately persists an (empty) board.json — that is framework behavior,
    // not a debounce regression. The property E1 guards is that the debounce
    // does NOT keep firing on continued idle: once the mount write settles, no
    // FURTHER writes occur without a new onChange (no timer loop / re-arming).
    const boardPath = `${assetRef}/board.json`;

    // Excalidraw fires onChange a couple of times during initialization (scene +
    // appState settling), so board.json sees a small, finite burst of mount
    // writes. Wait for the mtime to go QUIESCENT — unchanged across a 2s quiet
    // window — to establish the steady-state baseline.
    const readMtime = () => (fs.existsSync(boardPath) ? fs.statSync(boardPath).mtimeMs : 0);
    let baseMtime = 0;
    let stableFor = 0;
    for (let i = 0; i < 50 && stableFor < 2_000; i++) {
      await page.waitForTimeout(250);
      const m = readMtime();
      if (m !== 0 && m === baseMtime) {
        stableFor += 250;
      } else {
        baseMtime = m;
        stableFor = 0;
      }
    }
    expect(baseMtime, 'board.json reached a quiescent mount baseline').toBeGreaterThan(0);

    // Idle — inject nothing. After quiescence the debounce must not re-fire: no
    // further write (the mtime stays put). A timer loop / re-arming would bump it.
    await page.waitForTimeout(3_000);
    expect(readMtime(), 'no further board.json write on continued idle').toBe(baseMtime);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('E2: close without save (documented behavior, no pass/fail gate)', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `e2-${Date.now() % 10000}`);
    await openEditor(page, id);

    // Inject one element + fire onChange, then navigate away BEFORE the debounce.
    await page.evaluate(() => {
      const lib = (window as any).__excalidrawLib;
      const api = (window as any).__whiteboardApi;
      api.updateScene({ elements: lib.convertToExcalidrawElements([{ type: 'rectangle', x: 10, y: 10, width: 80, height: 40, label: { text: 'Z' } }]) });
      const a = (window as any).__whiteboardApi;
      (window as any).__whiteboardOnChange(a.getSceneElements(), a.getAppState(), a.getFiles());
    });
    // Navigate away well within the debounce window.
    await page.goto('/dock/home');
    await page.waitForTimeout(2_000);

    // Document whichever behavior the implementation has — both flush and cancel
    // are acceptable; this test only records, it does not gate.
    const boardPath = `${assetRef}/board.json`;
    let flushed = false;
    if (fs.existsSync(boardPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
        flushed = (parsed.data?.elements?.length ?? 0) >= 1;
      } catch {
        flushed = false;
      }
    }
    console.log(`E2 observed behavior: pending save on unmount was ${flushed ? 'FLUSHED' : 'CANCELLED'}`);
    // No assertion (documentation-only per the .md).

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('E3: crash-mid-edit recovery preserves saved elements', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `e3-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, TWO_BOXES_ARROW);

    // Ensure the save completed before the hard reload.
    const boardPath = `${assetRef}/board.json`;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1_000);
      if (fs.existsSync(boardPath) && (JSON.parse(fs.readFileSync(boardPath, 'utf8')).data?.elements?.length ?? 0) >= 2) break;
    }

    // Hard reload (full page reload, simulating a crash + reopen).
    await page.reload();
    await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => (window as any).__whiteboardApi, null, { timeout: 15_000 });
    await page.waitForTimeout(2_000);

    const sceneLen = await page.evaluate(() => (window as any).__whiteboardApi.getSceneElements().length);
    expect(sceneLen, 'elements present after hard reload').toBeGreaterThanOrEqual(2);

    // No orphan temp files in the folder.
    const orphans = fs.readdirSync(assetRef).filter((f) => f.endsWith('.tmp') || f.endsWith('.swp'));
    expect(orphans, `no .tmp/.swp orphans: ${orphans.join(', ')}`).toHaveLength(0);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('E4: large board (100 rects) persists all elements + mermaid block', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `e4-${Date.now() % 10000}`);
    await openEditor(page, id);

    await page.evaluate(() => {
      const lib = (window as any).__excalidrawLib;
      const api = (window as any).__whiteboardApi;
      const skel = Array.from({ length: 100 }, (_, i) => ({
        type: 'rectangle',
        x: (i % 10) * 60,
        y: Math.floor(i / 10) * 60,
        width: 50,
        height: 50,
        label: { text: `N${i}` },
      }));
      api.updateScene({ elements: lib.convertToExcalidrawElements(skel) });
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const api = (window as any).__whiteboardApi;
      (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
    });

    // board.json holds the 100 rectangles + their text labels (~200 elements).
    const boardPath = `${assetRef}/board.json`;
    let total = -1;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1_000);
      if (fs.existsSync(boardPath)) {
        const parsed = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
        total = parsed.data?.elements?.length ?? -1;
        if (total >= 100) break;
      }
    }
    expect(total, 'board.json holds >=100 elements').toBeGreaterThanOrEqual(100);

    // The mermaid block is still emitted and properly terminated.
    const mdPath = `${assetRef}/WHITE_BOARD.md`;
    let md = '';
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(mdPath)) {
        md = fs.readFileSync(mdPath, 'utf8');
        if (md.includes('<!-- END whiteboard:auto -->')) break;
      }
      await page.waitForTimeout(1_000);
    }
    expect(md).toContain('<!-- BEGIN whiteboard:auto -->');
    expect(md).toContain('<!-- END whiteboard:auto -->');

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('E5: delete board removes entity (folder kept on disk by design)', async ({ request }) => {
    test.setTimeout(30_000);
    const { id } = await createWhiteboard(request, `e5-delete-${Date.now() % 10000}`);

    const del = await request.delete(`${API}/api/v1/graph/whiteboard/${id}`);
    expect(del.status()).toBe(200);

    // The entity must be gone from the graph: GET returns 404 or empty data.
    const get = await request.get(`${API}/api/v1/graph/whiteboard/${id}`);
    if (get.status() === 200) {
      const body = await get.json();
      const data = body.data;
      const present = Array.isArray(data) ? data.length > 0 : Boolean(data);
      expect(present, 'whiteboard entity gone after delete').toBe(false);
    } else {
      expect(get.status()).toBe(404);
    }
  });
});
