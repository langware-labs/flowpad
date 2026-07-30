import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { apiBase } from '../_shared/api';

const API = apiBase();
// Whiteboard is a REPO asset, so user scope uses the same registry-owned
// agentic-assets/<type> layout as project scope, rooted at the user's home.
const USER_WHITEBOARDS = path.join(os.homedir(), 'agentic-assets', 'whiteboard');

function projectWhiteboards(mount: string): string {
  return path.join(mount, 'agentic-assets', 'whiteboard');
}

async function pickProject(request: APIRequestContext): Promise<{ id: string; mount: string }> {
  const res = await request.get(`${API}/api/v1/graph/project`);
  const body = await res.json();
  const projects: any[] = body.data || [];
  // Prefer my_first_project; else first with a mount path.
  const pick =
    projects.find((p) => p.name === 'my_first_project' && p.fs_storage_mount_path) ||
    projects.find((p) => p.fs_storage_mount_path);
  expect(pick, 'a project with fs_storage_mount_path exists').toBeTruthy();
  return { id: pick.id, mount: pick.fs_storage_mount_path };
}

async function materialize(page: Page, id: string, assetRef: string) {
  await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
  await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => typeof (window as any).__whiteboardApi === 'object' && (window as any).__whiteboardApi, null, {
    timeout: 15_000,
  });
  // First save materializes the folder + board.json on disk.
  await page.evaluate(() => {
    const lib = (window as any).__excalidrawLib;
    const api = (window as any).__whiteboardApi;
    const els = lib.convertToExcalidrawElements([{ type: 'rectangle', x: 10, y: 10, width: 80, height: 40, label: { text: 'X' } }]);
    api.updateScene({ elements: els });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const api = (window as any).__whiteboardApi;
    (window as any).__whiteboardOnChange(api.getSceneElements(), api.getAppState(), api.getFiles());
  });
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1_000);
    if (fs.existsSync(`${assetRef}/board.json`)) break;
  }
}

test.describe('Whiteboard — Scope (Sc1–Sc2)', () => {
  test('Sc1: project-scoped board creation materializes under the project mount', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id: projectId, mount } = await pickProject(request);

    const res = await request.post(`${API}/api/v1/graph/project/${projectId}/whiteboard`, {
      data: { name: `sc1-proj-${Date.now() % 10000}` },
    });
    expect(res.status()).toBe(200);
    const { id, asset_ref } = (await res.json()).data;
    // Both scopes use agentic-assets/whiteboard; the scope root is what differs.
    expect(path.dirname(asset_ref), `asset_ref ${asset_ref} under project mount ${mount}`).toBe(
      projectWhiteboards(mount),
    );
    expect(path.dirname(asset_ref), `asset_ref ${asset_ref} must NOT be user-scope`).not.toBe(USER_WHITEBOARDS);

    await materialize(page, id, asset_ref);
    expect(fs.existsSync(asset_ref), 'project-scoped folder exists after mount').toBe(true);
    expect(fs.existsSync(`${asset_ref}/board.json`), 'project-scoped board.json exists').toBe(true);

    fs.rmSync(asset_ref, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });

  test('Sc2: user + project scopes coexist with distinct paths', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const { id: projectId, mount } = await pickProject(request);

    const userRes = await request.post(`${API}/api/v1/graph/whiteboard`, { data: { name: `sc2-user-${Date.now() % 10000}` } });
    const user = (await userRes.json()).data;
    const projRes = await request.post(`${API}/api/v1/graph/project/${projectId}/whiteboard`, {
      data: { name: `sc2-proj-${Date.now() % 10000}` },
    });
    const proj = (await projRes.json()).data;

    expect(user.id).not.toBe(proj.id);
    expect(path.dirname(user.asset_ref)).toBe(USER_WHITEBOARDS);
    expect(path.dirname(proj.asset_ref)).toBe(projectWhiteboards(mount));

    await materialize(page, user.id, user.asset_ref);
    await materialize(page, proj.id, proj.asset_ref);
    expect(fs.existsSync(user.asset_ref), 'user-scope folder exists').toBe(true);
    expect(fs.existsSync(proj.asset_ref), 'project-scope folder exists').toBe(true);

    fs.rmSync(user.asset_ref, { recursive: true, force: true });
    fs.rmSync(proj.asset_ref, { recursive: true, force: true });
    await request.delete(`${API}/api/v1/graph/whiteboard/${user.id}`).catch(() => {});
    await request.delete(`${API}/api/v1/graph/whiteboard/${proj.id}`).catch(() => {});
  });
});
