/**
 * Browser scenario — project dependencies (`flow.json`).
 *
 * A host project's flow.json declares:
 *   - `provider` (required, file:) — a folder holding an agent;
 *   - `lost`     (required, file:) — a folder that does not exist;
 *   - `extra`    (optional, file:) — a folder, not installed.
 *
 * In a real browser:
 *   1. Opening the project shows the missing-dependencies dialog naming `lost`;
 *      "Don't show again until Flowpad restarts" + Not now dismisses it, and a
 *      reload does not bring it back (the dismissal is backend memory).
 *   2. The Dependencies card lists all three with their states; Install brings
 *      in the optional one.
 *   3. The provider's agent is a tile on the host's home; clicking it opens a
 *      session that belongs to the HOST, runs in the host's folder, and mounts
 *      the provider (its home).
 *   4. Removing `lost` from the card takes it out of flow.json.
 *
 * Seeding writes files and calls the HTTP graph API directly.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, test } from '@playwright/test';

const BE = `http://localhost:${process.env.DEP_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;

let tmpRoot = '';
let hostDir = '';
let providerDir = '';
let extraDir = '';
let projectId = '';
const stamp = Date.now();
const agentName = `dep-helper-${stamp}`;

async function call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return r.json();
}

/** Tests other than the dialog's own start with its warning dismissed (the dialog is modal). */
async function dismissWarnings(): Promise<void> {
  await call('POST', `${GRAPH}/project/${projectId}/dismiss-dependency-warning`, { name: 'lost' });
}

async function dependencies(): Promise<any> {
  return (await call('GET', `${GRAPH}/project/${projectId}/dependencies`))?.data;
}

test.beforeAll(async () => {
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `backend not up on ${BE} — launch a disposable instance first`);
  }

  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-deps-e2e-')));
  hostDir = path.join(tmpRoot, `host-${stamp}`);
  providerDir = path.join(tmpRoot, `provider-${stamp}`);
  extraDir = path.join(tmpRoot, `extra-${stamp}`);
  const agentDir = path.join(providerDir, 'agentic-assets', 'agent', agentName);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, 'agent.json'),
    JSON.stringify({ name: agentName, title: `Dep Helper ${stamp}`, worker_type: 'claude', enabled: true }),
  );
  await fs.writeFile(path.join(agentDir, 'system_prompt.md'), 'Answer from docs/guide.md.\n');
  await fs.mkdir(path.join(providerDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(providerDir, 'docs', 'guide.md'), '# Guide\n');
  await fs.mkdir(extraDir, { recursive: true });
  await fs.mkdir(hostDir, { recursive: true });
  await fs.writeFile(
    path.join(hostDir, 'flow.json'),
    JSON.stringify(
      {
        dependencies: { provider: `file:${providerDir}`, lost: `file:${path.join(tmpRoot, 'lost')}` },
        optionalDependencies: { extra: `file:${extraDir}` },
      },
      null,
      2,
    ),
  );

  const created = await call('POST', `${GRAPH}/project`, {
    type: 'project',
    name: `deps-e2e-${stamp}`,
    fs_storage_mount_path: hostDir,
  });
  projectId = created?.data?.id;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);
  // Index the provider like opening the project would (fetching), so its agent is a row.
  await call('POST', `${GRAPH}/project/${projectId}/resolve-dependencies`, {});
});

test.afterAll(async () => {
  try {
    if (projectId) await call('POST', `${GRAPH}/project/${projectId}/delete-with-children`, {});
  } catch {
    /* best effort — the instance is disposable */
  }
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
});

test('a missing required dependency warns once, and dismissing lasts across reloads', async ({ page }) => {
  await page.goto(`/dock/project/${projectId}`);

  const dialog = page.getByTestId('missing-dependencies-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-testid="missing-dependency"][data-dependency-name="lost"]')).toBeVisible();
  await expect(dialog.locator('[data-dependency-name="extra"]')).toHaveCount(0); // optional never warns

  await page.getByTestId('missing-dependencies-dont-show').click();
  await page.getByTestId('missing-dependencies-not-now').click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await dependencies())?.warnings?.length).toBe(0);

  await page.reload();
  // The rows render from the same dependencies read the dialog decides on: once they
  // are here, the dialog has had its chance to open.
  await expect(
    page.getByTestId('project-dependencies-card').locator('[data-testid="dependency-row"][data-dependency-name="lost"]'),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
});

test('the card lists every dependency with its state, and Install brings in an optional one', async ({ page }) => {
  await dismissWarnings();
  await page.goto(`/dock/project/${projectId}`);
  const card = page.getByTestId('project-dependencies-card');
  const row = (name: string) => card.locator(`[data-testid="dependency-row"][data-dependency-name="${name}"]`);

  await expect(row('provider')).toHaveAttribute('data-state', 'ready');
  await expect(row('lost')).toHaveAttribute('data-state', 'missing');
  await expect(row('extra')).toHaveAttribute('data-state', 'not_installed');

  await row('extra').getByTestId('dependency-install').click();
  await expect(row('extra')).toHaveAttribute('data-state', 'ready');
  const extra = (await dependencies()).dependencies.find((d: any) => d.name === 'extra');
  expect(extra.state).toBe('ready');
});

test("a dependency's agent runs in the host project, with its own folder mounted", async ({ page }) => {
  await dismissWarnings();
  await page.goto(`/dock/project/${projectId}`);
  const tile = page.locator(`[data-testid="project-agent-tile"][data-agent-name="${agentName}"]`);
  await expect(tile).toBeVisible();
  await tile.click();

  await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-([0-9a-f-]+)/);
  const processId = /agentic_process-([0-9a-f-]{36})/.exec(page.url())![1];
  const proc = (await call('GET', `${GRAPH}/agentic_process/${processId}`))?.data;
  expect(proc.project_id).toBe(projectId);
  expect(proc.workdir).toBe(hostDir);
  expect(proc.additional_dirs).toContain(providerDir);
  expect(proc.context_data.instructions).toContain(`Your own files are in ${providerDir}`);
});

test('removing a dependency from the card takes it out of flow.json', async ({ page }) => {
  await dismissWarnings();
  await page.goto(`/dock/project/${projectId}`);
  const card = page.getByTestId('project-dependencies-card');
  const lost = card.locator('[data-testid="dependency-row"][data-dependency-name="lost"]');
  await lost.getByTestId('dependency-remove').click();
  await expect(lost).toHaveCount(0);
  const declared = JSON.parse(await fs.readFile(path.join(hostDir, 'flow.json'), 'utf8'));
  expect(Object.keys(declared.dependencies)).toEqual(['provider']);
  await expect(async () => expect(await fs.stat(providerDir)).toBeTruthy()).toPass(); // folders untouched
});

test('the assets navigator lists the dependencies under one root', async ({ page }) => {
  await dismissWarnings();
  await page.goto(`/dock/project/${projectId}`);
  await page.getByTestId('browseable-chevron-asset-context-folders-root').click();
  // A ready dependency is a folder row (it has children); its id ends in its folder.
  await expect(
    page.locator(`[data-testid^="browseable-chevron-asset-context-folder:"][data-testid$="provider-${stamp}"]`),
  ).toBeVisible();
});
