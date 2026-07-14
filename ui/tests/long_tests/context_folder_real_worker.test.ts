/**
 * Context folders → real worker, end to end (vitest long tier).
 *
 * Chain under test: `project.addContextDir(dir)` (mints a Folder entity,
 * links it into the project's private context bucket; `include_dirs` is now
 * server-computed from those links) → worker spawn mounts the folder via
 * --add-dir → a REAL Claude turn reads a sentinel file planted inside the
 * context folder (which lives OUTSIDE the worker's workdir) and echoes its
 * random token back into the chat output.
 *
 * Spawns its OWN isolated backend (fresh instance + port, pattern of
 * tests/api/project_context_dir.test.ts) with FLOWPAD_DEFAULT_WORKER=claude —
 * never touches a running dev/prod instance and always exercises THIS
 * checkout's backend code. Requires Claude Code installed + authed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSdkRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = process.env.TEST_INSTANCE || 'ctxworker';
const PORT = Number(process.env.TEST_PORT || 6082);

let proc: ChildProcess | undefined;
let sdk: any;
let disposeSdkRealm: (() => void) | undefined;
let tmpRoot = '';

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

function chatContent(outputs: any[], FlowElementTypes: any): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

beforeAll(async () => {
  const logPath = `/tmp/context_folder_real_worker.${INSTANCE}.log`;
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
        FLOWPAD_DEFAULT_WORKER: 'claude',
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close();
  }
  const up = await waitHealthy(PORT, 60_000);
  if (!up) throw new Error(`backend '${INSTANCE}' did not come up on :${PORT} — see ${logPath}`);

  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-real-worker-')));

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

describe('context folder reaches a real worker', () => {
  it('worker reads a sentinel inside an added context folder', async (context: any) => {
    const contextDir = path.join(tmpRoot, 'ctx');
    await fs.mkdir(contextDir, { recursive: true });
    const token = `CTXTOKEN-${Math.random().toString(36).slice(2, 14)}`;
    await fs.writeFile(path.join(contextDir, 'sentinel.txt'), `${token}\n`);
    const workdir = path.join(tmpRoot, 'wd');
    await fs.mkdir(workdir);

    // Attach the folder via the real HTTP action; the server-computed
    // include_dirs (derived from the Folder context link) must carry it.
    const project = await new sdk.Project({ name: workdir }).save();
    await project.addContextDir(contextDir);
    expect(project.include_dirs).toContain(contextDir);
    const reloaded = await sdk.Project.getById(project.id);
    expect(reloaded?.include_dirs ?? []).toContain(contextDir);

    // Real worker bound to the project (headless: prompt() streams the whole
    // turn; a PTY-visible process would 409 on it AND hit the known
    // first-prompt-no-autosubmit PTY behavior). The spawn mounts the context
    // folder via --add-dir.
    const worker = await new sdk.AgenticProcess({
      workdir,
      project_id: project.id,
      visible: false,
      pty_mode: false,
    }).save([]);

    await worker.prompt(
      `Read the file ${contextDir}/sentinel.txt and reply with its exact contents.`,
    );

    const content = chatContent(worker.flowDataStream.items, sdk.FlowElementTypes);
    console.log('[context_folder_real_worker] chat content:', content.slice(0, 400));

    if (isClaudeUnavailable(content)) {
      context.skip(`Claude unavailable: ${content.slice(0, 240)}`);
    }
    expect(content, 'worker must echo the sentinel token read through --add-dir').toContain(token);
  }, 200_000);
});
