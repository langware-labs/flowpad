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
  // Wait for the excalidraw dev hooks to populate.
  await page.waitForFunction(() => typeof (window as any).__whiteboardApi === 'object' && (window as any).__whiteboardApi, null, {
    timeout: 15_000,
  });
}

// Reliable inject: updateScene, let Excalidraw commit, then re-read the scene
// and pass THAT to the editor's onChange (calling onChange in the same tick as
// updateScene serializes a stale/empty scene).
async function injectAndSave(page: Page, skeleton: unknown[]) {
  await page.evaluate((skel) => {
    const lib = (window as any).__excalidrawLib;
    const api = (window as any).__whiteboardApi;
    const els = lib.convertToExcalidrawElements(skel);
    api.updateScene({ elements: els });
  }, skeleton);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const api = (window as any).__whiteboardApi;
    const scene = api.getSceneElements();
    (window as any).__whiteboardOnChange(scene, api.getAppState(), api.getFiles());
  });
}

const TWO_BOXES_ARROW = [
  { type: 'rectangle', id: 'R1', x: 50, y: 50, width: 140, height: 60, label: { text: 'A' } },
  { type: 'rectangle', id: 'R2', x: 280, y: 50, width: 140, height: 60, label: { text: 'B' } },
  { type: 'arrow', x: 190, y: 80, width: 90, height: 0, points: [[0, 0], [90, 0]], start: { id: 'R1' }, end: { id: 'R2' } },
];

test.describe('Whiteboard — Create + Persist (C1–C5)', () => {
  test('C1: quick-create via asset-list opens the editor', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    await page.goto('/dock/assets/list/whiteboard');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    // The browseable toolbar exposes a "New Whiteboard" affordance.
    const newBtn = page.locator('[data-testid="browseable-toolbar-new:whiteboard"]');
    await expect(newBtn).toBeVisible({ timeout: 15_000 });
    await newBtn.click();

    // A name dialog appears: a [role="dialog"] with a placeholder="Name" input
    // and a "Create" button.
    const dialog = page.locator('[role="dialog"]').filter({ has: page.locator('input[placeholder="Name"]') });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('input[placeholder="Name"]').fill(`c1-board-${Math.floor(1000 + Math.random() * 9000)}`);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 15_000 });
    expect(page.url()).toContain('/dock/assets/editor/whiteboard/');
  });

  test('C2–C3: files on disk + frontmatter id stamped (after first save)', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `c2-board-${Date.now() % 10000}`);
    await openEditor(page, id);
    // Folder materializes lazily on first save — trigger one. The save writes
    // board.json, then WHITE_BOARD.md, then the SVG thumbnail sequentially, so
    // poll for WHITE_BOARD.md (the last markdown write) rather than fixed-sleeping.
    await injectAndSave(page, TWO_BOXES_ARROW);
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1_000);
      if (fs.existsSync(`${assetRef}/WHITE_BOARD.md`) && fs.existsSync(`${assetRef}/board.json`)) break;
    }

    expect(fs.existsSync(`${assetRef}/WHITE_BOARD.md`), 'WHITE_BOARD.md exists after save').toBe(true);
    expect(fs.existsSync(`${assetRef}/board.json`), 'board.json exists after save').toBe(true);

    // C3a: right after save, autosave has only spliced the mermaid block — the
    // frontmatter id is NOT stamped on save (it is indexer-managed via
    // whiteboard_gen_id). Markers must already be present, though.
    const mdPreIndex = fs.readFileSync(`${assetRef}/WHITE_BOARD.md`, 'utf8');
    expect(mdPreIndex).toContain('<!-- BEGIN whiteboard:auto -->');
    expect(mdPreIndex).toContain('<!-- END whiteboard:auto -->');

    // C3b: an index pass stamps a valid UUID id into the frontmatter and
    // preserves the auto-managed mermaid block.
    const idxRes = await request.post(`${API}/api/v1/graph/compute_node/@local/fs-records/index?type=whiteboard`);
    expect(idxRes.status()).toBe(200);
    let md = '';
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500);
      md = fs.readFileSync(`${assetRef}/WHITE_BOARD.md`, 'utf8');
      if (/^---[\s\S]*?\bid:\s*[0-9a-fA-F-]{36}/m.test(md)) break;
    }
    // Frontmatter id (a valid v4/v5 UUID — version digit is 4 or 5).
    expect(md).toMatch(/^---[\s\S]*?\bid:\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[45][0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/m);
    // BEGIN/END mermaid markers survive the frontmatter stamp.
    expect(md).toContain('<!-- BEGIN whiteboard:auto -->');
    expect(md).toContain('<!-- END whiteboard:auto -->');

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('C4: draw + autosave writes board.json (>=2 elements) + thumbnail', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `c4-board-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, TWO_BOXES_ARROW);

    const bj = `${assetRef}/board.json`;
    let elementCount = -1;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1_000);
      if (fs.existsSync(bj)) {
        const parsed = JSON.parse(fs.readFileSync(bj, 'utf8'));
        elementCount = parsed.data?.elements?.length ?? -1;
        expect(parsed.kind).toBe('excalidraw');
        if (elementCount >= 2) break;
      }
    }
    expect(elementCount, 'board.json data.elements length').toBeGreaterThanOrEqual(2);

    // The thumbnail is the LAST write in persist (board.json → WHITE_BOARD.md →
    // exportToSvg → thumbnail.svg), so it lands a couple seconds after board.json.
    // Poll for it rather than single-shot — same wait budget, just the right file.
    const thumb = `${assetRef}/thumbnail.svg`;
    let thumbSize = 0;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(thumb)) {
        thumbSize = fs.statSync(thumb).size;
        if (thumbSize > 200) break;
      }
      await page.waitForTimeout(1_000);
    }
    expect(fs.existsSync(thumb), 'thumbnail.svg exists').toBe(true);
    expect(thumbSize, 'thumbnail.svg size > 200 bytes').toBeGreaterThan(200);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('C5: reload preserves content', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `c5-board-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, TWO_BOXES_ARROW);
    // Ensure board.json persisted before reload.
    const bj = `${assetRef}/board.json`;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1_000);
      if (fs.existsSync(bj) && (JSON.parse(fs.readFileSync(bj, 'utf8')).data?.elements?.length ?? 0) >= 2) break;
    }

    // Navigate away, then back.
    await page.goto('/dock/home');
    await page.waitForTimeout(1_000);
    await openEditor(page, id);
    await page.waitForTimeout(2_000);

    const sceneLen = await page.evaluate(() => (window as any).__whiteboardApi.getSceneElements().length);
    expect(sceneLen, 'scene elements preserved after reload').toBeGreaterThanOrEqual(2);

    // No React error boundary (the appState.collaborators Map regression surfaces here).
    expect(await page.getByRole('heading', { name: /^Error$/ }).count()).toBe(0);

    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });
});
