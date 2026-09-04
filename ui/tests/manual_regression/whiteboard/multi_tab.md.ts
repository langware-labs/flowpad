import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';

import { apiBase } from '../_shared/api';

const API = apiBase();

async function createWhiteboard(request: APIRequestContext, name: string) {
  const res = await request.post(`${API}/api/v1/graph/whiteboard`, { data: { name } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { id: body.data.id as string, assetRef: body.data.asset_ref as string };
}

async function openBoard(page: Page, id: string) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
  await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => typeof (window as any).__whiteboardApi === 'object' && (window as any).__whiteboardApi, null, {
    timeout: 15_000,
  });
}

// Inject one labelled rectangle and fire the editor's onChange with the
// committed scene (the 500ms gap lets updateScene commit before serialize).
async function injectRect(page: Page, label: string) {
  // Re-wait for the live hooks: the editor can remount between openEditor() and
  // here (a data-load re-render), clearing window.__whiteboardApi. Concrete signal.
  await page.waitForFunction(
    () => typeof (window as any).__whiteboardApi === 'object' && !!(window as any).__whiteboardApi
      && typeof (window as any).__excalidrawLib === 'object' && !!(window as any).__excalidrawLib,
    null, { timeout: 15_000 },
  );
  await page.evaluate((text) => {
    const lib = (window as any).__excalidrawLib;
    const api = (window as any).__whiteboardApi;
    api.updateScene({ elements: lib.convertToExcalidrawElements([{ type: 'rectangle', x: 30, y: 30, width: 90, height: 50, label: { text } }]) });
  }, label);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const api = (window as any).__whiteboardApi;
    (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
  });
}

function boardLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as any).__whiteboardApi
      .getSceneElements()
      .map((e: any) => e.text || '')
      .filter(Boolean),
  );
}

function fileLabels(boardPath: string): string[] {
  if (!fs.existsSync(boardPath)) return [];
  const els = JSON.parse(fs.readFileSync(boardPath, 'utf8')).data?.elements ?? [];
  return els.map((e: { text?: string }) => e.text || '').filter(Boolean);
}

// X1: concurrent edit in two tabs. Playwright's context.newPage() shares the
// browser context/session — that IS "the same board open in two tabs". The
// scenario's premise is the documented v1 limitation: Excalidraw OSS is
// single-user, there is NO live WS sync between tabs, so it is last-write-wins.
test.describe('Whiteboard — Multi-tab (X1)', () => {
  test('X1: two tabs on one board — no live sync, last-write-wins', async ({ context, request }) => {
    test.setTimeout(60_000);
    const { id, assetRef } = await createWhiteboard(request, `x1-${Date.now() % 10000}`);

    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await openBoard(tabA, id);
    await openBoard(tabB, id);

    const boardPath = `${assetRef}/board.json`;

    // Tab A injects "A" and saves past the debounce (board.json holds rect+label).
    await injectRect(tabA, 'A');
    await expect.poll(() => fileLabels(boardPath), { timeout: 10_000 }).toContain('A');

    // Tab B does NOT auto-update with A's element (no WS sync between tabs).
    await tabB.waitForTimeout(1_500);
    const bLabelsAfterA = await boardLabels(tabB);
    expect(bLabelsAfterA, "tab B's canvas did not receive tab A's element (single-user, no live sync)").not.toContain('A');

    // Tab B injects a DIFFERENT element "B" and saves — B is the last writer.
    await injectRect(tabB, 'B');
    await expect.poll(() => fileLabels(boardPath), { timeout: 10_000 }).toContain('B');

    // Reload tab A — it re-reads board.json, which (last-write-wins) now holds
    // tab B's scene ("B"), not tab A's "A".
    await tabA.reload();
    await tabA.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
    await tabA.waitForFunction(() => (window as any).__whiteboardApi, null, { timeout: 15_000 });
    await tabA.waitForTimeout(1_500);
    const aLabelsAfterReload = await boardLabels(tabA);
    expect(aLabelsAfterReload, "reloaded tab A shows tab B's last write").toContain('B');
    expect(aLabelsAfterReload, "tab A's own earlier 'A' was overwritten (last-write-wins)").not.toContain('A');

    await tabA.close();
    await tabB.close();
    fs.rmSync(assetRef, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });
});
