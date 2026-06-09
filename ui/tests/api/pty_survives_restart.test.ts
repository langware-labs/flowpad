/**
 * Characterization test: does a PTY shell survive a full backend restart?
 *
 * 1. Start a real /bin/sh PTY and confirm input echoes (baseline).
 * 2. Restart the backend (kills the PTY worker children).
 * 3. Send input to the SAME shell and wait for the echo.
 *
 * Runs against the disposable `dev-1` instance so it never touches the main
 * :9007 backend. Skips unless dev-1 is launched
 * (`scripts/instance_ctl.sh launch dev-1`) and restarts it via instance_ctl.
 *
 * NOTE on timeout: this genuinely restarts a server (instance_ctl relaunch +
 * WS reconnect), which is ~tens of seconds — the long timeout is inherent to the
 * scenario, not masking a slow path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ENV_FILE = path.join(REPO_ROOT, '.env.dev-1.local');
const PORT = (() => {
  if (!existsSync(ENV_FILE)) return null;
  const m = readFileSync(ENV_FILE, 'utf8').match(/^LOCAL_SERVER_PORT=(\d+)/m);
  return m ? m[1] : null;
})();

function decodePtyData(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function waitForEcho(manager: any, shellId: string, keyword: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let acc = '';
    const handler = (msg: any) => {
      if (msg.shell_id !== shellId) return;
      acc += decodePtyData(msg.data);
      if (acc.includes(keyword)) {
        clearTimeout(timer);
        manager.off('on_pty_output_msg', handler);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      manager.off('on_pty_output_msg', handler);
      reject(new Error(`Timeout waiting for "${keyword}". Got tail: ${JSON.stringify(acc.slice(-200))}`));
    }, timeoutMs);
    manager.on('on_pty_output_msg', handler);
  });
}

const suite = PORT ? describe : describe.skip;

suite('PTY survives server restart (dev-1)', () => {
  let sdk: any;
  let manager: any;
  let cn: any;
  let cnId: string;
  let shellId: string;

  const inputUrl = () => `${sdk.GRAPH_API_PREFIX}/${sdk.ComputeNode.type}/${cnId}/terminal-command/input`;
  const sendInput = (data: string) => sdk.apiClient.post(inputUrl(), { shell_id: shellId, data });

  beforeAll(async () => {
    // Realm: point the SDK graph at dev-1's backend before importing it.
    (globalThis as any).__FLOWPAD_API_URL__ = `http://localhost:${PORT}`;
    vi.resetModules();
    sdk = await import('@sdk');

    const info = await sdk.dataManager.bootstrap('localhost', true);
    await sdk.dataManager.loadTypes(info.types || []);
    manager = sdk.ConnectionManager.getInstance();
    if (!manager.connected) await manager.connect();

    cn = new sdk.ComputeNode({
      name: 'pty-restart-node',
      runtime: { name: 'test-runtime' },
      node_provider_type: sdk.ComputeProviderType.LOCAL_MACHINE,
      node_config: { launch: true },
      fs_storage_mount_path: `/tmp/flow-pty-restart-${Date.now()}`,
    });
    await cn.save();
    await cn.setup();
    cnId = cn.id;
  }, 60_000);

  it('echoes input again after a backend restart', async () => {
    // 1. Start a real /bin/sh PTY. shell_id must be a UUID — the SDK validates it
    //    as a type-id when dispatching pty_output_msg, else the echo is dropped.
    shellId = uuidv4();
    const startUrl = `${sdk.GRAPH_API_PREFIX}/${sdk.ComputeNode.type}/${cnId}/terminal-command/start`;
    await sdk.apiClient.post(startUrl, { shell_id: shellId, connection_id: manager.id, rows: 24, cols: 80 }, 60_000);

    // 2. Baseline: input echoes back over the WS.
    await sendInput("printf 'MARK_BEFORE_OK\\n'\n");
    await waitForEcho(manager, shellId, 'MARK_BEFORE_OK', 15_000);

    // 3. Restart the backend (synchronous; kills the PTY worker children).
    execFileSync('scripts/instance_ctl.sh', ['launch', 'dev-1'], { cwd: REPO_ROOT, stdio: 'ignore' });

    // 4. Wait for the SDK's connection to auto-reconnect to the fresh backend,
    //    then re-init the compute node provider so input can route at all.
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('ws not reconnected');
      },
      { timeout: 40_000, interval: 1_000 },
    );
    await cn.setup();

    // 5. Same shell — does input still echo? (The assertion under test.)
    await sendInput("printf 'MARK_AFTER_OK\\n'\n");
    await waitForEcho(manager, shellId, 'MARK_AFTER_OK', 20_000);
  }, 120_000);
});
