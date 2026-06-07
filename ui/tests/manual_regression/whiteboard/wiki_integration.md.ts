import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const API = process.env.API_URL || 'http://localhost:6002';
const DB = path.join(os.homedir(), '.flow/instances/qa-1/flowpad.db');

async function materialize(page: Page, id: string, assetRef: string) {
  await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
  await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => typeof (window as any).__whiteboardApi === 'object' && (window as any).__whiteboardApi, null, {
    timeout: 15_000,
  });
  await page.evaluate(() => {
    const lib = (window as any).__excalidrawLib;
    const api = (window as any).__whiteboardApi;
    api.updateScene({ elements: lib.convertToExcalidrawElements([{ type: 'rectangle', x: 10, y: 10, width: 80, height: 40, label: { text: 'X' } }]) });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const api = (window as any).__whiteboardApi;
    (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
  });
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1_000);
    if (fs.existsSync(`${assetRef}/WHITE_BOARD.md`)) break;
  }
}

test.describe('Whiteboard participates in the wiki graph', () => {
  test('a whiteboard whose WHITE_BOARD.md has a [[wiki-link]] creates a links-table edge', async ({ page, request }) => {
    test.setTimeout(90_000);
    test.skip(!fs.existsSync(DB), `instance DB not found at ${DB}`);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    const targetName = `wiki-target-q2-${Date.now() % 100000}`;
    const srcName = `wiki-src-q2-${Date.now() % 100000}`;

    // Create the wiki target (markdown).
    const mdRes = await request.post(`${API}/api/v1/graph/markdown`, { data: { name: targetName, body: '# target\n' } });
    expect(mdRes.status()).toBe(200);
    const mdId = (await mdRes.json()).data.id;

    // Create the source whiteboard + materialize its WHITE_BOARD.md.
    const wbRes = await request.post(`${API}/api/v1/graph/whiteboard`, { data: { name: srcName } });
    expect(wbRes.status()).toBe(200);
    const wb = (await wbRes.json()).data;
    await materialize(page, wb.id, wb.asset_ref);
    expect(fs.existsSync(`${wb.asset_ref}/WHITE_BOARD.md`), 'WHITE_BOARD.md materialized').toBe(true);

    // Navigate away to UNMOUNT the editor before touching WHITE_BOARD.md. Otherwise
    // a still-pending debounced autosave can do its own read-modify-write of the
    // file AFTER our append — it read currentDoc before the append, then rewrites
    // the pre-append content via spliceMermaidBlock, clobbering the [[link]] and
    // racing the indexer to an edge-less file. Unmounting cancels pending saves.
    await page.goto('/dock/home');
    await page.waitForTimeout(1_000);

    // Append a prose wiki link to the board's markdown.
    fs.appendFileSync(`${wb.asset_ref}/WHITE_BOARD.md`, `\nSee [[${targetName}]] for details.\n`);
    const md = fs.readFileSync(`${wb.asset_ref}/WHITE_BOARD.md`, 'utf8');
    expect(md).toContain(targetName);

    // Wiki edges are (re)extracted on fs-records index, not on autosave.
    const idxRes = await request.post(`${API}/api/v1/graph/compute_node/@local/fs-records/index?type=whiteboard`);
    expect(idxRes.status()).toBe(200);
    await page.waitForTimeout(3_000);

    // Query the links table for the edge whiteboard -> target name. The raw wiki
    // target name lives in `target_raw` (there is no `target_name` column).
    const q = `SELECT count(*) FROM links WHERE src_type='whiteboard' AND target_raw='${targetName}';`;
    const count = parseInt(execSync(`sqlite3 "${DB}" "${q}"`).toString().trim(), 10);
    expect(count, 'links-table edge from whiteboard to target').toBeGreaterThanOrEqual(1);

    // Cleanup (best-effort).
    fs.rmSync(wb.asset_ref, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${wb.id}`).catch(() => {});
    await request.delete(`${API}/api/v1/graph/markdown/${mdId}`).catch(() => {});
  });
});
