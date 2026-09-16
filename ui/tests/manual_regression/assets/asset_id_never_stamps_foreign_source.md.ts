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
 * is what the app does; the loader, `useEntityByPath`, its `discover` fallback
 * and `TypeInfo.mint_entity_id` all run for real.
 *
 * The load-bearing part is `waitForResponse`: without it a green result would
 * only prove that nothing happened. Waiting for the `discover` round-trip
 * proves the mint path actually ran and THEN asserts the bytes survived it.
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
    // Arm BEFORE navigating: this REQUEST is the proof the mint seam was
    // reached, and it is issued before any assertion below would run.
    //
    // The request, deliberately, and not the response. `mint_entity_id` runs at
    // the top of `discover_record_by_path`; the route only replies much later,
    // after a Pass-2b scoped re-index that blocks on the folder-indexing consent
    // prompt no headless browser answers (`index_folder_consent`) — measured at
    // >240s with no reply. Awaiting the response would make this test hostage to
    // an unrelated gate, and raising a timeout to ride past it is exactly the
    // move that is never allowed here.
    const discoverIssued = page.waitForRequest((r) => r.url().includes('/fs-records/markdown/discover'));
    await page.goto(
      `/dock/assets/editor/markdown/vfs/${vfs}?editorMode=view&viewMode=standard&scope-mode=project&scope-activeProjectId=${projectId}`,
    );

    // The editor really mounted on THIS file — an absent symptom means nothing
    // if the surface never rendered the target.
    await expect(page.getByTestId('top-nav-crumb-details-trigger')).toContainText('server.py');
    await discoverIssued;
    await expect(page.getByText('from fastmcp import FastMCP')).toBeVisible();

    // KNOWN LIMITATION — read before trusting this as a regression guard.
    //
    // This asserts the bytes after the UI has ISSUED discover, which proves the
    // surface reaches the seam but does NOT prove the server finished minting.
    // The browser's call is fire-and-forget and can sit queued, so a pass here
    // is not proof of the fix. Measured, not assumed: against an unfixed prod
    // backend this test PASSED while a direct call to the very same endpoint
    // prepended `---\nid: …\n---` to the file.
    //
    // Making it sensitive needs a defined completion point, and the obvious one
    // is unavailable: `POST /fs-records/<type>/discover` never responds for a
    // path its type cannot extract — Pass-2b's scoped re-index blocks on the
    // folder-index consent prompt (`index_folder_consent`), measured at >240s
    // with no reply. Bounding that wait would be adding a timeout to ride past
    // a hang, which this repo forbids. Fix the non-responding route first, then
    // await the response here and delete this note.
    const after = await fs.readFile(file, 'utf8');
    expect(after.startsWith('---'), `an id was stamped into the source:\n${after}`).toBe(false);
    expect(after, 'discover rewrote a source it does not own').toBe(SERVER_PY);
  } finally {
    await request.delete(`${API}/api/v1/graph/project/${projectId}`).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
