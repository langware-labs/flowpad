/**
 * A credential, end to end, from the TS SDK: declared → filled by `flow project setup`'s AI rung →
 * its status read back.
 *
 *   1. `new Project(...).save()` and `credentialsService.save(...)` declare `demo-service` in it;
 *   2. the literal `flow project setup`, nobody at the terminal — every question left empty, so the
 *      AI rung runs. The agent is the mock worker (`tests/utils/demo_credential`): a few lines of
 *      Python that pipe the setup's values into the store command its prompt names, so this pins
 *      the I/O between the pieces, not a model;
 *   3. `credentialsService.status(projectId)` reports it connected, every value present in the
 *      project's env file, and no value anywhere in the payload.
 *
 * The Python tier runs the same path through the CLI and the Python SDK
 * (`tests/long_tests/test_credentials_declare_fill_status.py`). Runs against a fresh, isolated
 * backend instance (own data dir + port, no hub, no frontend), so it never touches the dev backend.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSdkRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = process.env.TEST_INSTANCE || 'credfill';
const PORT = Number(process.env.TEST_PORT || 6083);
const FIXTURE = path.join(REPO_ROOT, 'tests/utils/demo_credential');
const ENDPOINT = 'https://demo.example.test/api';

let proc: ChildProcess | undefined;
let sdk: any;
let disposeSdkRealm: (() => void) | undefined;
let tmpRoot = '';
let backendEnv: NodeJS.ProcessEnv = {};

async function waitHealthy(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** `flow <args>` in `cwd`, as the instance's own CLI, its agent on the mock worker. Nobody at the terminal. */
function flow(cwd: string, transcripts: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('uv', ['run', '--project', REPO_ROOT, 'python', path.join(REPO_ROOT, 'tests/utils/mock_flow_cli.py'), ...args], {
      cwd,
      env: {
        ...backendEnv,
        MOCK_TRANSCRIPTS: transcripts,
        MOCK_BEHAVIOR: 'tests.utils.demo_credential:follow_setup',
        PYTHONPATH: REPO_ROOT,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-cred-')));
  backendEnv = {
    ...process.env,
    FLOW_INSTANCE: INSTANCE,
    HOME: tmpRoot,
    FLOW_HOME: path.join(tmpRoot, '.flow'),
    FLOWPAD_CLAUDE_HOME: path.join(tmpRoot, '.claude'),
    CLAUDE_CONFIG_DIR: path.join(tmpRoot, '.claude'),
    LOCAL_SERVER_PORT: String(PORT),
    MINIHUB_RELOAD: 'False',
    FLOWPAD_SKIP_DOTENV: 'true',
    FLOWPAD_SKIP_LOCK: 'true',
  };
  const logPath = `/tmp/credentials_declare_fill_status.${INSTANCE}.log`;
  const logHandle = await fs.open(logPath, 'w');
  try {
    proc = spawn('uv', ['run', '-m', 'flow_sdk.server.run'], {
      cwd: REPO_ROOT,
      env: backendEnv,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close();
  }
  const up = await waitHealthy(PORT, 60_000);
  if (!up) throw new Error(`backend '${INSTANCE}' did not come up on :${PORT} — see ${logPath}`);

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

describe('credentials: declare → flow project setup (AI rung) → status', () => {
  it('a declared credential is filled by the AI rung and the SDK status reflects it', async () => {
    // 1. A project, and the credential it declares.
    const project = await new sdk.Project({ name: `credfill-${Date.now()}` }).save();
    const mount = project.fs_storage_mount_path as string;
    expect(mount).toBeTruthy();
    await fs.mkdir(mount, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: mount }); // `.env.local` must be ignorable to be written
    await fs.writeFile(path.join(mount, 'service.url'), `${ENDPOINT}\n`);
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE, 'secret_pack.json'), 'utf-8'));
    const declared = await sdk.credentialsService.save({ scope: 'project', project_id: project.id, manifest });
    expect(declared.name).toBe('demo-service');

    const before = await sdk.credentialsService.status(project.id);
    const missing = before.credentials.find((r: any) => r.name === 'demo-service');
    expect(missing?.state).toBe('missing');

    // 2. `flow project setup`, nobody at the terminal → the AI rung fills it.
    const transcripts = path.join(tmpRoot, 'transcripts');
    const setup = flow(mount, transcripts, 'project', 'setup', '--json');
    expect(setup.code, setup.out).toBe(0);
    const outcome = JSON.parse(setup.out.trim().split('\n').pop() as string);
    expect(outcome.ok, setup.out).toBe(true);

    // 3. The status, through the TS SDK.
    const status = await sdk.credentialsService.status(project.id);
    const row = status.credentials.find((r: any) => r.name === 'demo-service');
    expect(row).toMatchObject({ scope: 'project', state: 'connected', environment: 'development' });
    for (const v of row.vars) expect(v).toMatchObject({ present: true, found_in: 'env', warning: null });
    const envFile = status.files.find((f: any) => f.path === path.join(mount, '.env.local'));
    expect(envFile).toMatchObject({ exists: true, blocked: false });

    const stored = readFileSync(path.join(mount, '.env.local'), 'utf-8');
    const key = /^DEMO_API_KEY='?(demo_[0-9a-f]{32})'?$/m.exec(stored)?.[1];
    expect(key, 'the AI rung stored a key on its pattern').toBeTruthy();
    expect(JSON.stringify(status)).not.toContain(key);
    expect(setup.out).not.toContain(key);
  }, 60_000);
});
