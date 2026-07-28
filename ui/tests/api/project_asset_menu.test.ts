/**
 * API-tier validation for the Assets **menu** served by `project/{id}/get-assets`.
 *
 * Mirrors the pytest scenarios in `tests/unit/test_project_asset_menu.py`, but
 * end-to-end over real HTTP through the SDK, so the wire contract (query-param
 * binding, `menu` envelope key, snake_case field names) is proven rather than
 * assumed.
 *
 * The fixture is a 3-level context-folder chain. A context folder is "itself a
 * Project" only when a Project's mount IS that folder, so the deep levels are
 * real Projects created with explicit mounts; the bottom level is a plain
 * directory, which must still appear as a leaf node with its own counts:
 *
 *   A (project)  ──ctx──▶  B (project)  ──ctx──▶  C (project)  ──ctx──▶  leaf (plain dir)
 *   a_skill                 b_skill                 c_skill                 leaf_skill
 *
 * Runs against a fresh, isolated backend (own data dir + port, no hub, no
 * frontend). Ambient-backend style would be wrong here twice over: the api
 * setup installs a skill leak tripwire, and the exact-count assertions need an
 * instance the developer's own workspace hasn't populated.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSdkRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = process.env.TEST_INSTANCE || 'menufast';
const PORT = Number(process.env.TEST_PORT || 6082);

let proc: ChildProcess | undefined;
let sdk: any;
let disposeSdkRealm: (() => void) | undefined;
let tmpRoot = '';

/** mount path per fixture level. */
const dirs: Record<'A' | 'B' | 'C' | 'leaf', string> = { A: '', B: '', C: '', leaf: '' };
let projectA: any;

async function waitHealthy(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/v1/health/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** A dummy skill at `<dir>/.claude/skills/<name>/SKILL.md`. Returns its folder. */
async function writeSkill(dir: string, name: string): Promise<string> {
  const skillDir = path.join(dir, '.claude', 'skills', name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: menu fixture skill\n---\n\n# ${name}\n`,
  );
  return skillDir;
}

/**
 * Index one project's own mount. `addContextDir` indexes the folder it links,
 * which covers every level BELOW the root — but the root project is nobody's
 * context folder, so its own assets need this explicit scoped walk.
 * `user=false&projects=<id>` resolves to exactly one REAL_PROJECT_CWD root.
 */
async function indexProject(projectId: string): Promise<void> {
  const url =
    `${sdk.GRAPH_API_PREFIX}/compute_node/@local/fs-records/index` +
    `?user=false&projects=${encodeURIComponent(projectId)}`;
  await sdk.apiClient.post(url, {});
}

beforeAll(async () => {
  const logPath = `/tmp/project_asset_menu.${INSTANCE}.log`;
  const logHandle = await fs.open(logPath, 'w');
  try {
    proc = spawn('uv', ['run', '-m', 'flow_sdk.server.run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FLOW_INSTANCE: INSTANCE,
        LOCAL_SERVER_PORT: String(PORT),
        MINIHUB_RELOAD: 'False',
        FLOWPAD_SKIP_DOTENV: 'true',
        FLOWPAD_SKIP_LOCK: 'true',
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close();
  }
  const up = await waitHealthy(PORT, 60_000);
  if (!up) throw new Error(`backend '${INSTANCE}' did not come up on :${PORT} — see ${logPath}`);

  // realpath resolves symlinks (macOS /var → /private/var) so these match the
  // backend's canonical_posix_path form exactly.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-menu-')));
  for (const key of ['A', 'B', 'C', 'leaf'] as const) {
    dirs[key] = path.join(tmpRoot, key);
    await fs.mkdir(dirs[key], { recursive: true });
  }

  const realm = await createSdkRealm(`http://localhost:${PORT}`);
  sdk = realm.sdk;
  disposeSdkRealm = realm.dispose;
  const info = await sdk.dataManager.bootstrap('localhost', true);
  await sdk.dataManager.loadTypes(info.types || []);

  // Every SKILL.md exists before any linking, so each addContextDir indexes a
  // folder whose content is already on disk.
  await writeSkill(dirs.A, 'a_skill');
  await writeSkill(dirs.B, 'b_skill');
  await writeSkill(dirs.C, 'c_skill');
  await writeSkill(dirs.leaf, 'leaf_skill');

  const stamp = Date.now();
  projectA = await new sdk.Project({ name: `menuA-${stamp}`, fs_storage_mount_path: dirs.A }).save();
  const projectB = await new sdk.Project({ name: `menuB-${stamp}`, fs_storage_mount_path: dirs.B }).save();
  const projectC = await new sdk.Project({ name: `menuC-${stamp}`, fs_storage_mount_path: dirs.C }).save();

  // Bottom-up, so each level's context folder already has its own links.
  await projectC.addContextDir(dirs.leaf);
  await projectB.addContextDir(dirs.C);
  await projectA.addContextDir(dirs.B);

  await indexProject(projectA.id);
}, 120_000);

afterAll(async () => {
  disposeSdkRealm?.();
  proc?.kill('SIGTERM');
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// ── helpers ──────────────────────────────────────────────────────────────────

function walk(node: any): any[] {
  return [node, ...(node.children ?? []).flatMap((c: any) => walk(c))];
}
function byPath(root: any): Record<string, any> {
  return Object.fromEntries(walk(root).map((n) => [n.path, n]));
}
function count(node: any, typeName: string): number {
  return node.groups.find((g: any) => g.type_name === typeName)?.count ?? 0;
}
function own(node: any, typeName: string): number {
  return node.groups.find((g: any) => g.type_name === typeName)?.own_count ?? 0;
}

/** The menu, once all four skills have propagated into it. */
async function settledMenu(): Promise<any> {
  await vi.waitFor(
    async () => {
      const menu = await projectA.getAssetMenu();
      const n = count(menu?.root ?? { groups: [] }, 'skill');
      if (n < 4) throw new Error(`only ${n}/4 skills accumulated so far`);
    },
    { timeout: 30_000, interval: 1_000 },
  );
  return projectA.getAssetMenu();
}

// ── cases ────────────────────────────────────────────────────────────────────

describe('project asset menu (get-assets ?menu=true)', () => {
  it('nests context folders 3 levels deep, DFS', async () => {
    const menu = await settledMenu();
    expect(menu.root.path).toBe(dirs.A);
    expect(menu.root.source).toBe('project_dir');
    expect(menu.root.depth).toBe(0);

    const nodes = byPath(menu.root);
    for (const [depth, key] of [[1, 'B'], [2, 'C'], [3, 'leaf']] as const) {
      expect(nodes[dirs[key]], `${key} missing from the menu`).toBeTruthy();
      expect(nodes[dirs[key]].depth, `${key} at wrong depth`).toBe(depth);
      expect(nodes[dirs[key]].source).toBe('context_dir');
    }

    // Genuinely nested, not flattened onto the root.
    expect(menu.root.children).toHaveLength(1);
    expect(menu.root.children[0].path).toBe(dirs.B);
    expect(menu.root.children[0].children[0].path).toBe(dirs.C);
    expect(menu.root.children[0].children[0].children[0].path).toBe(dirs.leaf);
  }, 60_000);

  it('marks context folders that are themselves Projects', async () => {
    const nodes = byPath((await settledMenu()).root);
    for (const key of ['B', 'C'] as const) {
      expect(nodes[dirs[key]].is_project, `${key} should be a Project`).toBe(true);
      expect(nodes[dirs[key]].project_id).toBeTruthy();
    }
    // The bottom level is a plain directory: a leaf, but still counted.
    expect(nodes[dirs.leaf].is_project).toBe(false);
    expect(nodes[dirs.leaf].project_id).toBeNull();
    expect(nodes[dirs.leaf].children).toEqual([]);
    expect(count(nodes[dirs.leaf], 'skill')).toBe(1);
  }, 60_000);

  it('accumulates counts up every node', async () => {
    const menu = await settledMenu();
    for (const node of walk(menu.root)) {
      for (const group of node.groups) {
        const childrenTotal = (node.children ?? []).reduce(
          (sum: number, c: any) => sum + count(c, group.type_name),
          0,
        );
        expect(
          group.count,
          `${node.name}/${group.type_name} broke the accumulation invariant`,
        ).toBe(group.own_count + childrenTotal);
      }
    }

    const nodes = byPath(menu.root);
    expect(own(menu.root, 'skill')).toBe(1);   // A's own
    expect(count(menu.root, 'skill')).toBe(4); // + B + C + leaf
    expect(count(nodes[dirs.B], 'skill')).toBe(3);
    expect(count(nodes[dirs.C], 'skill')).toBe(2);
    expect(count(nodes[dirs.leaf], 'skill')).toBe(1);
  }, 60_000);

  it('ships counts only — no per-type registry metadata', async () => {
    // The client holds the type registry synchronously from bootstrap, so icon
    // / label / view-mode tier are looked up there, never re-sent per response.
    const menu = await settledMenu();
    const skill = menu.root.groups.find((g: any) => g.type_name === 'skill');
    expect(Object.keys(skill).sort()).toEqual(['count', 'own_count', 'type_name']);
  }, 60_000);

  it('recursive=false stops at the project itself', async () => {
    await settledMenu();
    const menu = await projectA.getAssetMenu({ recursive: false });
    expect(menu.root.children).toEqual([]);
    expect(count(menu.root, 'skill')).toBe(1);
  }, 60_000);

  it('maxDepth caps the walk', async () => {
    await settledMenu();
    const menu = await projectA.getAssetMenu({ maxDepth: 2 });
    const nodes = byPath(menu.root);
    expect(nodes[dirs.C]).toBeTruthy();
    expect(nodes[dirs.leaf]).toBeUndefined();
    expect(count(nodes[dirs.C], 'skill')).toBe(own(nodes[dirs.C], 'skill'));
  }, 60_000);

  it('is read-only — repeated calls are identical and nothing is minted', async () => {
    const before = await settledMenu();
    const dirsBefore = [...((await sdk.Project.getById(projectA.id))?.include_dirs ?? [])];

    const after = await projectA.getAssetMenu();

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const dirsAfter = (await sdk.Project.getById(projectA.id))?.include_dirs ?? [];
    expect(dirsAfter).toEqual(dirsBefore);
    // The plain leaf directory was NOT promoted to a Project.
    expect(await sdk.Project.getProjectByPath(dirs.leaf)).toBeFalsy();
  }, 60_000);

  it('leaves the flat getAssets response untouched', async () => {
    const assets = await projectA.getAssets();
    expect(Array.isArray(assets)).toBe(true);
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) expect(a).toHaveProperty('source');
  }, 60_000);
});
