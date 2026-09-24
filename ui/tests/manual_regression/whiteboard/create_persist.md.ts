import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';

import { apiBase } from '../_shared/api';

const API = apiBase();

// Every board a test creates lands in the user-scope family on disk; afterEach
// removes it whether the test passed or not, so a red run leaves nothing behind.
const created: Array<{ id: string; assetRef: string }> = [];

async function createWhiteboard(request: APIRequestContext, name: string) {
  const res = await request.post(`${API}/api/v1/graph/whiteboard`, { data: { name } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const board = { id: body.data.id as string, assetRef: body.data.asset_ref as string };
  created.push(board);
  return board;
}

const UUID_V4_V5 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[45][0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The `id:` in WHITE_BOARD.md's frontmatter — the whiteboard's identity carrier. */
function frontmatterId(md: string): string | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  return fm?.[1].match(/^id:\s*['"]?([^'"\s]+)/m)?.[1] ?? null;
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
  // The editor can remount between openEditor() and here (a data-load re-render),
  // which clears window.__whiteboardApi. Re-wait for the live hook right before
  // using it — a concrete-signal wait, not a fixed delay.
  await page.waitForFunction(
    () => typeof (window as any).__whiteboardApi === 'object' && !!(window as any).__whiteboardApi
      && typeof (window as any).__excalidrawLib === 'object' && !!(window as any).__excalidrawLib,
    null,
    { timeout: 15_000 },
  );
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
  test.afterEach(async ({ request }) => {
    for (const { id, assetRef } of created.splice(0)) {
      await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
      fs.rmSync(assetRef, { recursive: true, force: true });
    }
  });

  test('C1: create opens the whiteboard editor', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
    // Whiteboards are created via the API/editor route (the asset-browser tree
    // renders a curated root set — agent/skill/markdown/spec — and does not offer
    // a whiteboard quick-create toolbar entry). Create then open the editor.
    const { id } = await createWhiteboard(request, `c1-board-${Math.floor(1000 + Math.random() * 9000)}`);
    await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
    await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 15_000 });
    expect(page.url()).toContain('/dock/assets/editor/whiteboard/');
  });

  test('C2–C3: files on disk + frontmatter id present (after first save)', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
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

    // C3: the whiteboard's identity carrier is WHITE_BOARD.md's frontmatter
    // (TypeInfo `identity_carrier=frontmatter_identity()`; the folder-capsule and
    // folder-name id forms were retired in 835d68760). The id is minted at create,
    // so it is already there right after the first save, next to the mermaid block
    // the autosave splices in.
    const md = fs.readFileSync(`${assetRef}/WHITE_BOARD.md`, 'utf8');
    expect(md).toContain('<!-- BEGIN whiteboard:auto -->');
    expect(md).toContain('<!-- END whiteboard:auto -->');
    const savedId = frontmatterId(md);
    expect(savedId ?? '', 'frontmatter id is a valid v4/v5 UUID').toMatch(UUID_V4_V5);
    expect(savedId, 'frontmatter id is the entity id assigned at create').toBe(id);

    // An index pass keeps the same id and the mermaid markers.
    const idx = await request.post(`${API}/api/v1/graph/compute_node/@local/fs-records/index?type=whiteboard`);
    expect(idx.status()).toBe(200);
    const mdAfterIndex = fs.readFileSync(`${assetRef}/WHITE_BOARD.md`, 'utf8');
    expect(frontmatterId(mdAfterIndex), 'index pass keeps the frontmatter id').toBe(id);
    expect(mdAfterIndex).toContain('<!-- BEGIN whiteboard:auto -->');
    expect(mdAfterIndex).toContain('<!-- END whiteboard:auto -->');
  });

  test('C4: draw + autosave writes board.json (>=2 elements) + thumbnail', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
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

  });

  test('C5: reload preserves content', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
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

  });
});
