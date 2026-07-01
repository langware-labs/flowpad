/**
 * Browser scenario — project context folders (`include_dirs`).
 *
 * The requested end-to-end check, in a real browser:
 *   1. Create a temp folder with a dummy skill (`.claude/skills/<n>/SKILL.md`).
 *   2. Create a fresh project on dev-1 and add the folder as a context folder
 *      via the real backend action (`project.addContextDir`) — which persists
 *      include_dirs and indexes the skill.
 *   3. Load the project home in the browser and assert the ProjectBrief
 *      "Context folders" section renders the added folder.
 *
 * Backend seeding uses the dev-1 HTTP graph API directly (create project +
 * add-context-dir action). The browser then renders against dev-1's frontend.
 *
 * Prereq: dev-1 is launched (frontend :5002, backend :6001).
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, test } from '@playwright/test';

const BE = `http://localhost:${process.env.CTX_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;

let projectId = '';
let tmpRoot = '';
let contextDir = '';

async function post(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return r.json();
}

test.beforeAll(async () => {
  // Skip cleanly if dev-1's backend isn't up.
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `dev-1 backend not up on ${BE} — launch it first`);
  }

  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-ctx-e2e-')));
  contextDir = path.join(tmpRoot, 'ctx');
  const skillDir = path.join(contextDir, '.claude', 'skills', 'ctx_skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: ctx_skill\ndescription: dummy context-folder skill\n---\n\nHello from a context folder.\n',
  );

  // Create a fresh project (empty → ProjectBrief shows) then add the folder via
  // the real action (persists include_dirs + indexes the skill).
  const created = await post(`${GRAPH}/project`, { type: 'project', name: `ctx-e2e-${Date.now()}` });
  projectId = created?.data?.id;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);
  await post(`${GRAPH}/project/${projectId}/add-context-dir`, { path: contextDir });
});

test.afterAll(async () => {
  try {
    if (projectId) {
      await fetch(`${GRAPH}/project/${projectId}/delete-with-children`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
      });
    }
  } catch {
    /* best effort — dev-1 is disposable */
  }
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

test('ProjectBrief shows the added context folder', async ({ page }) => {
  await page.goto(`/dock/project/${projectId}`);

  // ProjectBrief renders on an empty project home; its context-folders section
  // + the added folder row must appear.
  const section = page.getByTestId('project-context-folders');
  await expect(section).toBeVisible();

  const row = page.getByTestId(`context-folder-row-${contextDir}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('ctx'); // basename of the context folder

  // The dropzone (drop a folder / click to add) is wired.
  await expect(page.getByTestId('context-folder-dropzone')).toBeVisible();
});
