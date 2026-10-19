/**
 * FLOWPAD-2083 — opening a foreign source under an asset editor must not EDIT it.
 *
 * A bundled MCP server's `server.py` was found on disk with YAML frontmatter
 * prepended (`---\nid: aec9b4d5-…\n---`), which made it stop importing:
 * `SyntaxError: invalid decimal literal, line 2`. The id was never persisted
 * anywhere — the signature of a carrier write that happens eagerly, before
 * anything commits.
 *
 * The URL below is the reproduction, and it is NOT synthetic: `markdown` +
 * `vfs/<any path>` is the shape `DockPointer.forAssetEditor` emits whenever
 * `editorForType` has no editor for a type (`?? AssetEditor.MARKDOWN`), and
 * `AssetEditorRouter`'s VFS branch then labels the file with the editor's
 * primary record type without ever consulting the path — the same route
 * `vfs_files_tree_selection.md.ts` drives for a real `.md`. Routing through it
 * is what the app does; the loader, `useEntityByPath` and its resolve fallback
 * (`GET /api/v1/assets/resolve?path=…` — THE path → asset resolver since
 * e5f3b5cf7, which replaced the old `/fs-records/<type>/discover` call) all run
 * for real.
 *
 * The load-bearing part is `waitForResponse`: without it a green result would
 * only prove that nothing happened. Waiting for the resolve round-trip proves
 * the resolve/mint seam actually ran to completion for THIS file and THEN
 * asserts the bytes survived it.
 *
 * Against a fixed backend this passes. Against one without the fix it fails
 * with the frontmatter header in the diff — that is the control, not a flake.
 */
import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase } from '../_shared/api';

const API = apiBase();

/** The damaged file's shape: an MCP server whose folder has no `mcp.json`, so
 *  no type's `layout_of` claims either the script or the folder around it. */
const SERVER_PY = 'from fastmcp import FastMCP\n\nmcp = FastMCP("crm-mcp")\n';

test('opening a .py under the markdown editor never stamps an id into it', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  // realpath for the same reason the sibling VFS spec does it: the project route
  // adopts the canonical mount, so the URL must be built from that identity.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-2083-')));
  const file = path.join(root, 'agentic-assets', 'mcp', 'crm-mcp', 'server.py');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, SERVER_PY);

  const created = await request.post(`${API}/api/v1/graph/project`, {
    data: { name: path.basename(root), fs_storage_mount_path: root },
  });
  expect(created.status()).toBe(200);
  const projectId = (await created.json()).data.id as string;

  try {
    const vfs = `compute_node-@local/${file.replace(/^\/+/, '').replace(/\\/g, '/')}`;
    // Arm BEFORE navigating: the resolver's RESPONSE for this file is the proof
    // the seam ran to completion. It answers (404: a .py with no manifest is not
    // an asset) — unlike the retired discover route, which never replied for a
    // path its type could not extract.
    const resolved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/assets/resolve?') &&
        (new URL(r.url()).searchParams.get('path') ?? '').endsWith('crm-mcp/server.py'),
    );
    await page.goto(
      `/dock/assets/editor/markdown/vfs/${vfs}?editorMode=view&viewMode=standard&scope-mode=project&scope-activeProjectId=${projectId}`,
    );

    // The editor really mounted on THIS file — an absent symptom means nothing
    // if the surface never rendered the target.
    await expect(page.getByTestId('top-nav-crumb-details-trigger')).toContainText('server.py');
    await resolved;
    await expect(page.getByText('from fastmcp import FastMCP')).toBeVisible();

    const after = await fs.readFile(file, 'utf8');
    expect(after.startsWith('---'), `an id was stamped into the source:\n${after}`).toBe(false);
    expect(after, 'resolve rewrote a source it does not own').toBe(SERVER_PY);
  } finally {
    await request.delete(`${API}/api/v1/graph/project/${projectId}`).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
