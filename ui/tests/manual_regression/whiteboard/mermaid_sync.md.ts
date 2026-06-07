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

async function waitMermaidContains(page: Page, mdPath: string, needle: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1_000);
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, 'utf8');
      if (md.includes(needle)) return md;
    }
  }
  return fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
}

const TWO_BOXES_ARROW = [
  { type: 'rectangle', id: 'R1', x: 50, y: 50, width: 140, height: 60, label: { text: 'A' } },
  { type: 'rectangle', id: 'R2', x: 280, y: 50, width: 140, height: 60, label: { text: 'B' } },
  { type: 'arrow', x: 190, y: 80, width: 90, height: 0, points: [[0, 0], [90, 0]], start: { id: 'R1' }, end: { id: 'R2' } },
];

test.describe('Whiteboard — Mermaid Auto-sync (M1–M5)', () => {
  test('M1: mermaid block written', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `m1-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, TWO_BOXES_ARROW);
    const md = await waitMermaidContains(page, `${assetRef}/WHITE_BOARD.md`, 'flowchart TD');
    expect(md).toContain('<!-- BEGIN whiteboard:auto -->');
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart TD');
    expect(md).toContain('<!-- END whiteboard:auto -->');
    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('M2: human content preserved outside markers', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `m2-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, TWO_BOXES_ARROW);
    const mdPath = `${assetRef}/WHITE_BOARD.md`;
    await waitMermaidContains(page, mdPath, 'flowchart TD');

    // Insert prose above BEGIN and below END, plus a wiki link below.
    const orig = fs.readFileSync(mdPath, 'utf8');
    const withProse = orig
      .replace('<!-- BEGIN whiteboard:auto -->', 'PROSE_ABOVE_MARKER\n<!-- BEGIN whiteboard:auto -->')
      .replace('<!-- END whiteboard:auto -->', '<!-- END whiteboard:auto -->\nPROSE_BELOW_MARKER [[my-wiki-link]]');
    fs.writeFileSync(mdPath, withProse);

    // Trigger another save (one more element).
    await injectAndSave(page, [...TWO_BOXES_ARROW, { type: 'rectangle', x: 50, y: 200, width: 100, height: 40, label: { text: 'C' } }]);
    await waitMermaidContains(page, mdPath, 'C');
    await page.waitForTimeout(1_500);

    const after = fs.readFileSync(mdPath, 'utf8');
    expect(after, 'prose above marker preserved').toContain('PROSE_ABOVE_MARKER');
    expect(after, 'prose below marker preserved').toContain('PROSE_BELOW_MARKER');
    expect(after, 'wiki link preserved').toContain('[[my-wiki-link]]');
    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('M3: degenerate (freehand-only) board still emits valid mermaid', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `m3-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, [{ type: 'freedraw', x: 0, y: 0, points: [[0, 0], [50, 20], [100, 30]] }]);
    const md = await waitMermaidContains(page, `${assetRef}/WHITE_BOARD.md`, 'flowchart TD');
    expect(md).toContain('flowchart TD');
    // Loose-elements comment mentioning freedraw; the fenced block is non-empty.
    expect(md).toMatch(/%%\s*loose elements:[\s\S]*freedraw/i);
    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('M4: decision diamond emits double-curly (or single-curly) node', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `m4-${Date.now() % 10000}`);
    await openEditor(page, id);
    await injectAndSave(page, [{ type: 'diamond', x: 50, y: 200, width: 100, height: 80, label: { text: 'OK?' } }]);
    const md = await waitMermaidContains(page, `${assetRef}/WHITE_BOARD.md`, 'OK?');
    // mermaid v10+ double-curly, or single-curly backward-compat.
    expect(md).toMatch(/N\d+\{\{OK\?\}\}|N\d+\{OK\?\}/);
    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('M5: mermaid import dialog adds elements + re-syncs markdown', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id, assetRef } = await createWhiteboard(request, `m5-${Date.now() % 10000}`);
    await openEditor(page, id);

    await page.locator('[data-testid="open-import-mermaid"]').click();
    const ta = page.locator('[data-testid="mermaid-import-textarea"]');
    await expect(ta).toBeVisible({ timeout: 10_000 });
    await ta.fill('flowchart TD\n  X[Foo] --> Y[Bar]');
    await page.locator('[data-testid="confirm-import-mermaid"]').click();
    await page.waitForTimeout(2_000);

    // Scene now contains rectangles labelled Foo and Bar.
    const labels = await page.evaluate(() =>
      (window as any).__whiteboardApi
        .getSceneElements()
        .map((e: any) => e.text || '')
        .filter(Boolean),
    );
    expect(labels.join(' ')).toContain('Foo');
    expect(labels.join(' ')).toContain('Bar');

    // Markdown re-synced to contain the imported tokens.
    const md = await waitMermaidContains(page, `${assetRef}/WHITE_BOARD.md`, 'Foo');
    expect(md).toContain('Foo');
    expect(md).toContain('Bar');
    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });
});
