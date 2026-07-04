import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port);
        else reject(new Error('Could not allocate a port'));
      });
    });
  });
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health/status`);
      if (resp.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready: ${baseUrl}`);
}

function repoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

describe('wizard process lifecycle over the real SDK transport', () => {
  let tempRoot = '';
  let baseUrl = '';
  let server: ChildProcessWithoutNullStreams | null = null;
  let serverExit: Promise<unknown> | null = null;
  let serverLog = '';

  beforeAll(async () => {
    const port = await freePort();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-wizard-vitest-'));
    baseUrl = `http://127.0.0.1:${port}`;
    const root = repoRoot();
    const python = fs.existsSync(path.join(root, '.venv/bin/python'))
      ? path.join(root, '.venv/bin/python')
      : 'python';
    const env = {
      ...process.env,
      FLOW_INSTANCE: `wizard-vitest-${Date.now()}`,
      FLOW_HOME: path.join(tempRoot, 'flow-home'),
      SQLITE_DATABASE_PATH: path.join(tempRoot, 'flowpad.db'),
      MINIHUB_HOST: '127.0.0.1',
      LOCAL_SERVER_PORT: String(port),
      FLOWPAD_SKIP_DOTENV: 'true',
      PYTHONPATH: `${root}${path.delimiter}${process.env.PYTHONPATH ?? ''}`,
    };

    server = spawn(python, ['-m', 'flow_sdk.server.run'], {
      cwd: root,
      env,
      stdio: 'pipe',
    });
    server.stdout.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    server.stderr.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    serverExit = new Promise((resolve) => {
      server?.once('exit', resolve);
    });

    await waitForServer(baseUrl);
    (globalThis as any).__FLOWPAD_API_URL__ = baseUrl;
  }, 45_000);

  afterAll(async () => {
    delete (globalThis as any).__FLOWPAD_API_URL__;
    if (server && server.exitCode === null && !server.killed) {
      server.kill('SIGTERM');
      await Promise.race([
        serverExit,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (tempRoot && !process.env.KEEP_WORKDIR) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('completeWizard resolves awaitWizardResult through a real watched AgenticProcess', async () => {
    const sdk = await import('@sdk');
    const {
      AgenticProcess,
      ComputeNode,
      ConnectionManager,
      ContextEntitiesEnum,
      ProcessKind,
      awaitWizardResult,
      completeWizard,
      dataContext,
      dataManager,
      instancePreferences,
    } = sdk;

    await dataManager.reset();
    const bootstrapInfo = await dataManager.bootstrap('127.0.0.1', true);
    await dataManager.loadTypes(bootstrapInfo.types || []);
    dataContext.bootstrapInfo = bootstrapInfo;
    if (bootstrapInfo.default_compute_node) {
      const node = new ComputeNode(bootstrapInfo.default_compute_node as any);
      node.markAsExpanded();
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId, node.typeId);
    }
    await instancePreferences.loadJson();

    const connectionManager = ConnectionManager.getInstance();
    if (!connectionManager.connected) {
      await connectionManager.connect();
    }

    const proc = await new AgenticProcess({
      process_type: ProcessKind.Wizard,
      visible: false,
      pty_mode: false,
      load_flowpad_assistant: false,
      context_data: { wizard: { name: 'git-setup' } },
    }).save([]);
    await proc.watch();

    const awaited = awaitWizardResult<{ localPath: string }>(proc, { timeoutMs: 15_000 });
    await completeWizard(proc, {
      status: 'done',
      data: { localPath: '/tmp/app' },
      errorStr: null,
    });

    await expect(awaited).resolves.toEqual({
      status: 'done',
      data: { localPath: '/tmp/app' },
      errorStr: null,
    });
  }, 30_000);
});
