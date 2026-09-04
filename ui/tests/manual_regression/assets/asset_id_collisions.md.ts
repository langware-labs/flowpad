import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForIndexerIdle, apiBase } from '../_shared/api';

const API = apiBase();
const createdRoots = new Set<string>();
const createdEntities = new Set<string>();

interface SeededAsset {
  id: string;
  asset_ref: string;
}

interface ReflectedAsset extends SeededAsset {
  duplicate_count: number;
  asset_occurrences: Array<{ path: string; first_seen_at: string }>;
}

function git(cwd: string, args: string[], date?: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env,
  });
}

async function createProject(request: APIRequestContext, root: string): Promise<string> {
  const name = `qa-collision-${path.basename(root)}`;
  const response = await request.post(`${API}/api/v1/graph/project`, {
    data: { name, fs_storage_mount_path: root },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data.id;
}

async function createAsset(
  request: APIRequestContext,
  projectId: string,
  type: 'subagent' | 'skill',
  name: string,
): Promise<SeededAsset> {
  const response = await request.post(`${API}/api/v1/graph/project/${projectId}/${type}`, {
    data: { name },
  });
  expect(response.status(), await response.text()).toBe(200);
  const seeded = (await response.json()).data as SeededAsset;
  createdEntities.add(`${type}:${seeded.id}`);
  return seeded;
}

async function indexType(
  request: APIRequestContext,
  projectId: string,
  type: 'subagent' | 'skill',
): Promise<void> {
  // Single-flight index: creating the fixture asset kicks an auto-index, and a
  // second POST while it runs is refused with 409. Wait on the node's own idle
  // signal; budget 0 = bounded only by the test cap.
  expect(await waitForIndexerIdle(request, 0), 'index activity idle').toBe(true);
  const response = await request.post(
    `${API}/api/v1/graph/compute_node/@local/fs-records/index` +
      `?type=${type}&projects=${projectId}&user=false&force=true`,
  );
  expect(response.status(), await response.text()).toBe(200);
}

async function invalidateDeletedPaths(
  request: APIRequestContext,
  survivingPath: string,
  deletedPaths: string[],
): Promise<void> {
  const response = await request.post(
    `${API}/api/v1/graph/compute_node/@local/fs-records/invalidate`,
    { data: { paths: [survivingPath], deleted_paths: deletedPaths } },
  );
  expect(response.status(), await response.text()).toBe(200);
}

async function entity(request: APIRequestContext, type: string, id: string): Promise<ReflectedAsset> {
  const response = await request.get(`${API}/api/v1/graph/${type}/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as ReflectedAsset;
}

async function openAsset(page: Page, type: 'subagent' | 'skill', id: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  await page.goto(`/dock/assets/editor/${type}/typeid/${type}-${id}`);
  await expect(page.locator('[data-testid="asset-collision-warning"]')).toBeVisible();
}

/**
 * The panel hoists the common prefix into a "Common path" line and prints only
 * the per-row suffix, so the visible text never holds the whole path — the
 * full path lives on the row's `title`.
 */
function rowPath(row: Locator): Locator {
  return row.locator('.font-mono[title]').first();
}

test.afterEach(async ({ request }) => {
  for (const key of createdEntities) {
    const [type, id] = key.split(':', 2);
    await request.delete(`${API}/api/v1/graph/${type}/${id}`).catch(() => null);
    createdEntities.delete(key);
  }
  for (const root of createdRoots) {
    const projects = await request.get(`${API}/api/v1/graph/project`).catch(() => null);
    if (projects?.ok()) {
      const rows: Array<{ id: string; fs_storage_mount_path?: string }> =
        (await projects.json()).data ?? [];
      const project = rows.find((row) => path.resolve(row.fs_storage_mount_path ?? '') === path.resolve(root));
      if (project) await request.delete(`${API}/api/v1/graph/project/${project.id}`).catch(() => null);
    }
    fs.rmSync(root, { recursive: true, force: true });
    createdRoots.delete(root);
  }
});

test('File collision state, URL panel, and removal lifecycle', async ({ page, request }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowpad-collision-file-')));
  createdRoots.add(root);
  const projectId = await createProject(request, root);
  const seeded = await createAsset(request, projectId, 'subagent', `collision-agent-${randomUUID()}`);
  const source = path.resolve(seeded.asset_ref);
  const copyA = path.join(path.dirname(source), `copy-a-${randomUUID()}.md`);
  const copyB = path.join(path.dirname(source), `copy-b-${randomUUID()}.md`);
  fs.copyFileSync(source, copyA);
  fs.copyFileSync(source, copyB);

  await indexType(request, projectId, 'subagent');
  await expect.poll(async () => (await entity(request, 'subagent', seeded.id)).duplicate_count).toBe(2);

  await openAsset(page, 'subagent', seeded.id);
  const badge = page.locator('[data-testid="asset-collision-warning"]');
  await expect(badge).toContainText('2');
  await badge.click();

  await expect.poll(() => decodeURIComponent(new URL(page.url()).search)).toContain('asset-duplicates:subagent-');
  const panel = page.locator('[data-testid="asset-collision-panel"]');
  await expect(panel).toBeVisible();
  await expect(rowPath(panel.locator('[data-testid="asset-collision-row-primary"]'))).toHaveAttribute('title', source);
  await expect(panel.locator('[data-testid="asset-collision-row-duplicate"]')).toHaveCount(2);

  await page.goBack();
  await expect(panel).not.toBeVisible();
  await page.goForward();
  await expect(panel).toBeVisible();

  fs.unlinkSync(copyB);
  await invalidateDeletedPaths(request, source, [copyB]);
  await expect.poll(async () => (await entity(request, 'subagent', seeded.id)).duplicate_count).toBe(1);
  await expect(badge).toContainText('1');
  await expect(panel.locator('[data-testid="asset-collision-row-duplicate"]')).toHaveCount(1);

  fs.unlinkSync(copyA);
  await invalidateDeletedPaths(request, source, [copyA]);
  await expect.poll(async () => (await entity(request, 'subagent', seeded.id)).duplicate_count).toBe(0);
  await expect(badge).not.toBeVisible();
  await expect(panel).not.toBeVisible();
});

test('Git precedence and folder-backed collision parity', async ({ page, request }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowpad-collision-git-')));
  createdRoots.add(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'qa@flowpad.test']);
  git(root, ['config', 'user.name', 'Flowpad QA']);

  const projectId = await createProject(request, root);
  const seeded = await createAsset(request, projectId, 'skill', `z-original-${randomUUID()}`);
  const original = path.resolve(seeded.asset_ref);
  git(root, ['add', '--', path.relative(root, original)]);
  git(root, ['commit', '-m', 'add original skill'], '2020-01-01T00:00:00Z');

  const copy = path.join(path.dirname(original), `a-copy-${randomUUID()}`);
  fs.cpSync(original, copy, { recursive: true });
  git(root, ['add', '--', path.relative(root, copy)]);
  git(root, ['commit', '-m', 'add later copy'], '2021-01-01T00:00:00Z');

  await indexType(request, projectId, 'skill');
  await expect.poll(async () => (await entity(request, 'skill', seeded.id)).duplicate_count).toBe(1);
  const reflected = await entity(request, 'skill', seeded.id);
  expect(path.resolve(reflected.asset_ref)).toBe(original);

  await openAsset(page, 'skill', seeded.id);
  const badge = page.locator('[data-testid="asset-collision-warning"]');
  await expect(badge).toContainText('1');
  await badge.click();

  const panel = page.locator('[data-testid="asset-collision-panel"]');
  await expect(panel).toBeVisible();
  await expect(rowPath(panel.locator('[data-testid="asset-collision-row-primary"]'))).toHaveAttribute('title', original);
  await expect(rowPath(panel.locator('[data-testid="asset-collision-row-duplicate"]'))).toHaveAttribute('title', copy);
});
