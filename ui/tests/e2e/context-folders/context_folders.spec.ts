/**
 * Browser scenario — project context folders (`include_dirs`).
 *
 * The requested end-to-end check, in a real browser:
 *   1. Create a temp folder with a dummy skill (`.claude/skills/<n>/SKILL.md`).
 *   2. Create a fresh project and add the folder as a context folder via the
 *      real backend action (`project.addContextDir`) — which persists
 *      include_dirs and indexes the skill.
 *   3. Load the project in the browser and assert the Assets navigator's
 *      "Context folders" root lists the added folder.
 *
 * (The original assertion target — the ProjectHome "Context folders" card —
 * was removed in the July project-home redesign (8d6b05d98/80b55a972); the
 * feature now surfaces as the `asset-context-folders-root` row of the Assets
 * navigator tree, backed by the same include_dirs.)
 *
 * Backend seeding uses the HTTP graph API directly (create project +
 * add-context-dir action). The browser then renders against the frontend.
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

  // Create a fresh project (empty → ProjectHome shows) then add the folder via
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

/**
 * Suppress the harness-login gate BEFORE any page script runs.
 *
 * `useHarnessLoginGate` probes every assistant's sign-in state on mount and,
 * on a fresh instance where none is signed in, auto-opens the "Assistants &
 * keys" modal, whose Radix overlay covers the viewport with `pointer-events:
 * auto`. Those probes are async, so the modal lands an unpredictable moment
 * AFTER first paint and swallows whatever click is racing it.
 *
 * Seeding the same localStorage key the modal's own dismissal writes means the
 * gate never opens at all. That is the pattern the index-search scenarios
 * already use, and it removes the race rather than waiting the modal out:
 * a post-hoc poll can only sample a state that has not happened yet.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
});

test('Assets navigator lists the added context folder', async ({ page }) => {
  await page.goto(`/dock/project/${projectId}`);

  // The project view hosts the Assets navigator; its "Context folders" root
  // must render (the project is in scope even before any expansion).
  const root = page.getByText('Context folders', { exact: true });
  await expect(root).toBeVisible();

  // Nothing can be over the viewport: the harness-login gate is suppressed in
  // `beforeEach`, so this asserts a clear one instead of racing it.
  await expect(page.locator('div[data-state="open"].fixed.inset-0')).toHaveCount(0);

  // Expand the root (chevron id = the stable ASSET_CONTEXT_FOLDERS_ROOT_ID)
  // and assert the added folder appears as a child row, labeled by basename.
  await page.getByTestId('browseable-chevron-asset-context-folders-root').click();
  await expect(page.getByText('ctx', { exact: true })).toBeVisible();
});
