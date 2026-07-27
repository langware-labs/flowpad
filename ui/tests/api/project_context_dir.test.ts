/**
 * API-tier validation for project **context folders** (`include_dirs`).
 *
 * The scenario (matching the feature's acceptance check):
 *   1. Create a temp folder containing a dummy skill (`.claude/skills/<n>/SKILL.md`).
 *   2. Create a project and call `project.addContextDir(<temp folder>)` — the real
 *      HTTP action, which persists `include_dirs` AND indexes the folder so its
 *      skill becomes a discoverable asset.
 *   3. Bind an AgenticProcess to the project and call `getAssets()` — assert the
 *      dummy skill shows up attributed to `context_dir` (i.e. the worker launched
 *      under this project would mount it via --add-dir).
 *
 * Runs against a fresh, isolated backend instance (own data dir + port, no hub,
 * no frontend) so it is CI-safe and never touches the dev backend.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSdkRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = process.env.TEST_INSTANCE || 'ctxfast';
const PORT = Number(process.env.TEST_PORT || 6081);

let proc: ChildProcess | undefined;
let sdk: any;
let disposeSdkRealm: (() => void) | undefined;
let tmpRoot = '';
let contextDir = '';

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

beforeAll(async () => {
  const logPath = `/tmp/project_context_dir.${INSTANCE}.log`;
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

  // A dummy skill in a temp folder on the same machine the backend runs on.
  // realpath resolves symlinks (macOS /var → /private/var) so this matches the
  // backend's canonical_posix_path form exactly.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-ctx-')));
  contextDir = path.join(tmpRoot, 'ctx');
  const skillDir = path.join(contextDir, '.claude', 'skills', 'ctx_skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: ctx_skill\ndescription: dummy context-folder skill\n---\n\nHello from a context folder.\n',
  );

  const realm = await createSdkRealm(`http://localhost:${PORT}`);
  sdk = realm.sdk;
  disposeSdkRealm = realm.dispose;
  const info = await sdk.dataManager.bootstrap('localhost', true);
  await sdk.dataManager.loadTypes(info.types || []);
}, 90_000);

afterAll(async () => {
  disposeSdkRealm?.();
  proc?.kill('SIGTERM');
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('project context folders (include_dirs)', () => {
  it('addContextDir persists include_dirs and surfaces the skill as context_dir', async () => {
    // 1. Create a project.
    const project = await new sdk.Project({ name: `ctxproj-${Date.now()}` }).save();
    const mount = (project as any).fs_storage_mount_path as string;
    expect(mount).toBeTruthy();

    // 2. Add the context folder via the real HTTP action (persists + indexes).
    await project.addContextDir(contextDir);
    expect(project.include_dirs).toContain(contextDir);

    // Round-trip: a fresh fetch reflects the persisted field.
    const reloaded = await sdk.Project.getById(project.id);
    expect(reloaded?.include_dirs ?? []).toContain(contextDir);

    // 3. Bind an AgenticProcess to the project and read its assets. The dummy
    //    skill must appear attributed to `context_dir` (the injected --add-dir).
    const worker = await new sdk.AgenticProcess({
      project_id: project.id,
      workdir: mount,
      visible: false,
      pty_mode: false,
    }).save();

    await vi.waitFor(
      async () => {
        const assets = await worker.getAssets();
        const ctx = assets.filter((a: any) => a.source === 'context_dir');
        const hasSkill = ctx.some((a: any) => (a.typeid as string).startsWith('skill-'));
        if (!hasSkill) {
          throw new Error(
            `no context_dir skill yet (sources=${[...new Set(assets.map((a: any) => a.source))].join(',')})`,
          );
        }
      },
      { timeout: 30_000, interval: 1_000 },
    );

    const assets = await worker.getAssets();
    const ctx = assets.filter((a: any) => a.source === 'context_dir');
    expect(ctx.length).toBeGreaterThan(0);
    // Attribution carries the matched context dir.
    for (const a of ctx) expect(a.source_dir).toBe(contextDir);
  }, 60_000);

  it('shared scope + remove: link round-trips and removal survives reload', async () => {
    const project = await new sdk.Project({ name: `ctxproj2-${Date.now()}` }).save();
    const sharedDir = path.join(tmpRoot, 'shared-ctx');
    await fs.mkdir(sharedDir, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: sharedDir });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/flowpad-e2e/context-fixture.git'],
      { cwd: sharedDir },
    );

    // Shared scope requires a transportable origin. The local repository and
    // synthetic remote exercise real git-origin detection without network I/O.
    await project.addContextDir(sharedDir, 'shared');
    expect(project.include_dirs).toContain(sharedDir);
    const reloaded = await sdk.Project.getById(project.id);
    expect(reloaded?.include_dirs ?? []).toContain(sharedDir);

    // Remove unlinks (both buckets) — the SDK adopts the server response and a
    // fresh fetch agrees (the folder link is gone server-side, not just locally).
    await project.removeContextDir(sharedDir);
    expect(project.include_dirs).not.toContain(sharedDir);
    const reloaded2 = await sdk.Project.getById(project.id);
    expect(reloaded2?.include_dirs ?? []).not.toContain(sharedDir);
  }, 30_000);
});
