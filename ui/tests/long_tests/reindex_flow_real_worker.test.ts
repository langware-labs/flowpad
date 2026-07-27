/**
 * file change → reindex → entity change → refresh (vitest long tier).
 *
 * Validates the 4-part invalidation loop end to end against a REAL backend
 * spawned from THIS checkout:
 *
 *   1. inner file inside a folder-backed asset (skill folder) changes
 *   2. a standalone .md asset changes
 *   3. an asset file changed BY A REAL AGENT (agentic-process turn)
 *
 * For (1) and (2) the changed-file set is pushed via the general
 * `POST /fs-records/invalidate` endpoint (the same call the agent turn-end
 * hook makes). For (3) a real Claude turn edits the file and the
 * `_flush_transcript_change` busy→not-busy seam drives the reindex.
 *
 * Each scenario asserts the full chain: the entity's `updated_date` advances,
 * a `dataManager.subscribe` callback fires (the WS `data_op_msg` broadcast
 * landed), and the file body is re-readable with the new content.
 *
 * Spawns its OWN isolated backend (fresh instance + port) with
 * FLOWPAD_DEFAULT_WORKER=claude — never touches a running dev/prod instance.
 * Scenario 3 requires Claude Code installed + authed (skips on API-limit).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSdkRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = process.env.TEST_INSTANCE || 'reindexflow';
const PORT = Number(process.env.TEST_PORT || 6087);
let proc: ChildProcess | undefined;
let sdk: any;
let disposeSdkRealm: (() => void) | undefined;
let tmpRoot = '';

// SDK handles (populated in beforeAll after the realm import)
let apiClient: any;
let dataManager: any;
let systemTools: any;
let fsManager: any;
let TypeId: any;
let COMPUTE: any;

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

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

function chatContent(outputs: any[], FlowElementTypes: any): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

function toMs(d: any): number {
  if (d == null) return 0;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Read an entity's current server state (unwraps the {data} envelope). */
async function fetchEntity(type: string, id: string): Promise<any> {
  const res = await apiClient.get(`/graph/${type}/${id}`);
  return (res as any)?.data ?? res;
}

/** Push a changed-file set through the general invalidate endpoint. */
async function invalidate(paths: string[], deleted: string[] = []): Promise<any> {
  const res = await apiClient.post('/graph/compute_node/@local/fs-records/invalidate', {
    paths,
    deleted_paths: deleted,
  });
  return (res as any)?.data ?? res;
}

/**
 * Subscribe to an entity's live updates (node, no React). Records how many
 * times the callback fired and the latest `updated_date` seen. Relies on the
 * lowest-level `dataManager.subscribe` (store.ts) + the desktop single-user
 * "no watchers → all local connections" broadcast fallback.
 */
function subscribeUpdated(typeId: any) {
  const state = { fires: 0, lastUpdatedMs: 0 };
  // initialFetch=true populates the DataManager cache so `onDataOp`'s update
  // case (which early-returns on `!hasRef`) actually applies + notifies.
  const unsub = dataManager.subscribe(
    typeId,
    (e: any) => {
      state.fires += 1;
      const ms = toMs(e?.updated_date);
      if (ms > state.lastUpdatedMs) state.lastUpdatedMs = ms;
    },
    true,
  );
  return { state, unsub };
}

beforeAll(async () => {
  const logPath = `/tmp/reindex_flow_real_worker.${INSTANCE}.log`;
  const logHandle = await fs.open(logPath, 'w');
  const backendEnv = {
    ...process.env,
    FLOW_INSTANCE: INSTANCE,
    LOCAL_SERVER_PORT: String(PORT),
    MINIHUB_RELOAD: 'False',
    FLOWPAD_SKIP_DOTENV: 'true',
    FLOWPAD_SKIP_LOCK: 'true',
    FLOWPAD_DEFAULT_WORKER: 'claude',
  };
  const claudeConfigDir = backendEnv.CLAUDE_CONFIG_DIR;
  if (claudeConfigDir) {
    // An explicit Claude config root owns both credentials and transcripts;
    // make Flowpad observe that same root.
    backendEnv.FLOWPAD_CLAUDE_HOME = claudeConfigDir;
  } else {
    // Native Claude keeps credentials beside ~/.claude, not inside it. Merely
    // setting CLAUDE_CONFIG_DIR=~/.claude creates a different auth realm, so
    // keep both overrides absent and let Flowpad resolve the native default.
    delete backendEnv.FLOWPAD_CLAUDE_HOME;
    delete backendEnv.CLAUDE_CONFIG_DIR;
  }
  try {
    proc = spawn('uv', ['run', '-m', 'flow_sdk.server.run'], {
      cwd: REPO_ROOT,
      env: backendEnv,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
  } finally {
    // spawn duplicates the descriptor into the child; retaining this FileHandle
    // in the Vitest worker leaks it until garbage collection.
    await logHandle.close();
  }
  const up = await waitHealthy(PORT, 60_000);
  if (!up) throw new Error(`backend '${INSTANCE}' did not come up on :${PORT} — see ${logPath}`);

  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reindex-flow-')));

  const realm = await createSdkRealm(`http://localhost:${PORT}`);
  sdk = realm.sdk;
  disposeSdkRealm = realm.dispose;
  const info = await sdk.dataManager.bootstrap('localhost', true);
  await sdk.dataManager.loadTypes(info.types || []);

  apiClient = sdk.apiClient;
  dataManager = sdk.dataManager;
  systemTools = sdk.systemTools;
  fsManager = sdk.fsManager;
  TypeId = sdk.TypeId;
  COMPUTE = new TypeId('compute_node', '@local');

  // subscribe()-based reception requires the WS to be up.
  const cm = sdk.ConnectionManager.getInstance();
  if (!cm.connected) await cm.connect();
}, 90_000);

afterAll(async () => {
  // Dispose the one-off realm before terminating its backend so its connection
  // manager cannot keep retrying :6087 while later files use the live QA
  // backend.
  disposeSdkRealm?.();
  proc?.kill('SIGTERM');
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('file change → reindex → entity change → refresh', () => {
  it('scenario 1 — inner file inside a folder-backed asset (skill) bumps the owning entity', async () => {
    const skillDir = path.join(tmpRoot, 'skills', 'demo-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, 'SKILL.md');
    await fsManager.writeFile(COMPUTE, skillMd, '---\nname: demo-skill\ndescription: demo\n---\n# Demo\n');

    // Mint the skill entity by discovering the folder.
    const disc = await systemTools.discoverByPath('skill', skillDir);
    const id: string = disc.id;
    expect(id, 'skill discover must return an entity id').toBeTruthy();
    const typeId = new TypeId('skill', id);

    // Baseline (fetch BEFORE mutating so GET-time refresh doesn't preempt the invalidate).
    const before = await fetchEntity('skill', id);
    const updatedBefore = toMs(before.updated_date);
    const { state, unsub } = subscribeUpdated(typeId);

    // Mutate: add a NEW inner file (advances folder mtime + asset_hash).
    const innerPath = path.join(skillDir, 'notes.md');
    const marker = `INNER-${Math.random().toString(36).slice(2, 12)}`;
    await fsManager.writeFile(COMPUTE, innerPath, `# notes\n${marker}\n`);

    // Push the changed inner path; resolve_containing must map it to the skill.
    await invalidate([innerPath]);

    await vi.waitFor(
      () => {
        if (state.fires === 0) throw new Error('no subscribe callback yet');
        if (state.lastUpdatedMs <= updatedBefore) throw new Error('updated_date not advanced yet');
      },
      { timeout: 25_000, interval: 250 },
    );

    const after = await fetchEntity('skill', id);
    expect(toMs(after.updated_date)).toBeGreaterThan(updatedBefore);
    const innerBody = await fsManager.download(COMPUTE, innerPath);
    expect(String(innerBody)).toContain(marker);
    unsub();
  }, 60_000);

  it('scenario 1b — EDITING an existing inner file bumps the owning folder entity', async () => {
    const skillDir = path.join(tmpRoot, 'skills', 'edit-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, 'SKILL.md');
    await fsManager.writeFile(COMPUTE, skillMd, '---\nname: edit-skill\ndescription: v1\n---\n# v1\n');
    const disc = await systemTools.discoverByPath('skill', skillDir);
    const id: string = disc.id;
    const typeId = new TypeId('skill', id);
    const before = await fetchEntity('skill', id);
    const updatedBefore = toMs(before.updated_date);
    const { state, unsub } = subscribeUpdated(typeId);

    // EDIT the existing SKILL.md content (no add/remove — folder mtime unchanged).
    const marker = `EDIT-${Math.random().toString(36).slice(2, 12)}`;
    await fsManager.writeFile(COMPUTE, skillMd, `---\nname: edit-skill\ndescription: v2\n---\n# ${marker}\n`);
    await invalidate([skillMd]);

    await vi.waitFor(
      () => {
        if (state.lastUpdatedMs <= updatedBefore) throw new Error('updated_date not advanced yet');
      },
      { timeout: 25_000, interval: 250 },
    );
    const after = await fetchEntity('skill', id);
    expect(toMs(after.updated_date)).toBeGreaterThan(updatedBefore);
    unsub();
  }, 60_000);

  it('scenario 2 — standalone .md asset reindexes, broadcasts, new body readable', async () => {
    const mdPath = path.join(tmpRoot, 'doc.md');
    await fsManager.writeFile(COMPUTE, mdPath, '# doc\nv1\n');

    const disc = await systemTools.discoverByPath('markdown', mdPath);
    const id: string = disc.id;
    expect(id, 'markdown discover must return an entity id').toBeTruthy();
    const typeId = new TypeId('markdown', id);

    const before = await fetchEntity('markdown', id);
    const updatedBefore = toMs(before.updated_date);
    const { state, unsub } = subscribeUpdated(typeId);

    const marker = `MD-${Math.random().toString(36).slice(2, 12)}`;
    await fsManager.writeFile(COMPUTE, mdPath, `# doc\n${marker}\n`);
    await invalidate([mdPath]);

    await vi.waitFor(
      () => {
        if (state.fires === 0) throw new Error('no subscribe callback yet');
        if (state.lastUpdatedMs <= updatedBefore) throw new Error('updated_date not advanced yet');
      },
      { timeout: 25_000, interval: 250 },
    );

    const after = await fetchEntity('markdown', id);
    expect(toMs(after.updated_date)).toBeGreaterThan(updatedBefore);
    const body = await fsManager.download(COMPUTE, mdPath);
    expect(String(body)).toContain(marker);
    unsub();
  }, 60_000);

  it('scenario 3 — real agent edits a file → turn-end reindex → entity change → new body', async (context: any) => {
    const workdir = path.join(tmpRoot, 'agent-wd');
    await fs.mkdir(workdir, { recursive: true });
    const target = path.join(workdir, 'foo.md');
    await fsManager.writeFile(COMPUTE, target, '# foo\noriginal\n');

    const disc = await systemTools.discoverByPath('markdown', target);
    const id: string = disc.id;
    expect(id).toBeTruthy();
    const typeId = new TypeId('markdown', id);

    const before = await fetchEntity('markdown', id);
    const updatedBefore = toMs(before.updated_date);
    const { state, unsub } = subscribeUpdated(typeId);

    const marker = 'AGENT_MARKER_123';
    const worker = await new sdk.AgenticProcess({ workdir, visible: false, pty_mode: false }).save([]);
    await worker.watch();
    await worker.prompt(
      `Edit the file ${target} and set its ENTIRE content to exactly:\n${marker}\nDo not add anything else.`,
    );

    const chat = chatContent(worker.flowDataStream.items, sdk.FlowElementTypes);
    if (isClaudeUnavailable(chat)) context.skip(`Claude unavailable: ${chat.slice(0, 200)}`);

    // Separate "agent didn't edit" from "reindex didn't fire": the file must
    // carry the marker first (agent succeeded), then reactivity must land.
    const body = await fsManager.download(COMPUTE, target);
    console.log('[scenario3] chat:', chat.slice(0, 300));
    console.log('[scenario3] body after turn:', String(body).slice(0, 200));
    expect(String(body), 'agent must have edited foo.md with the marker').toContain(marker);

    await vi.waitFor(
      () => {
        if (state.lastUpdatedMs <= updatedBefore) throw new Error('updated_date not advanced yet');
      },
      { timeout: 25_000, interval: 250 },
    );

    const after = await fetchEntity('markdown', id);
    expect(toMs(after.updated_date)).toBeGreaterThan(updatedBefore);
    unsub();
  }, 200_000);
});
