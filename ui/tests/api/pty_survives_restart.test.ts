/**
 * Recovery test: does a BARE /bin/sh PTY come back after a full backend restart,
 * recovered by the backend watchdog (no client re-create)?
 *
 * 1. Start a real /bin/sh PTY and confirm input echoes (baseline — proves the
 *    output path works on the live WS before we perturb anything).
 * 2. Restart the backend (kills the PTY children; the in-memory PtyState is gone).
 * 3. The backend dead-PTY watchdog (`run_pty_recovery` → `_recover_bare_shells`)
 *    respawns the shell. The client only *re-attaches*: `terminal-command/attach`
 *    never creates a PTY (`get_pty` → handle or "not_found"), so polling it until
 *    it reports `reattached` proves the watchdog rebuilt the PTY server-side.
 *    This is the bare-shell analog of the agentic test's `os-status worker_alive`
 *    — a deterministic, HTTP-only recovery proof, independent of WS reconnection.
 *
 * Runs against the disposable `dev-1` instance so it never touches the main
 * :9007 backend. Skips unless dev-1 is launched
 * (`scripts/instance_ctl.sh launch dev-1`) and restarts it via instance_ctl.
 *
 * NOTE on timeout: this genuinely restarts a server (instance_ctl relaunch + a
 * ~5s-interval watchdog respawn), which is ~tens of seconds — the long test
 * timeout and the bounded poll budget are inherent to the scenario, not masking
 * a slow path.
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

// "Skips unless dev-1 is launched": the env file alone is not enough — dev-1 may
// be registered but its backend down (the launcher leaves .env.dev-1.local behind
// after a kill). Probe liveness so a down dev-1 SKIPS cleanly instead of failing
// beforeAll's bootstrap. The test genuinely needs a running dev-1 to restart.
const DEV1_LIVE = (() => {
  if (!PORT) return false;
  try {
    execFileSync('curl', ['-sf', '--max-time', '2', `http://localhost:${PORT}/api/v1/graph/bootstrap`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
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

const suite = DEV1_LIVE ? describe : describe.skip;

suite('Bare PTY recovered by backend watchdog after server restart (dev-1)', () => {
  let sdk: any;
  let manager: any;
  let cn: any;
  let cnId: string;
  let shellId: string;

  const termUrl = (op: string) => `${sdk.GRAPH_API_PREFIX}/${sdk.ComputeNode.type}/${cnId}/terminal-command/${op}`;
  const sendInput = (data: string) => sdk.apiClient.post(termUrl('input'), { shell_id: shellId, data });
  // `attach` never creates a PTY — it returns `reattached` only when the handle
  // exists, so it's our read-only probe that the watchdog rebuilt the shell.
  const attach = () =>
    sdk.apiClient.post(termUrl('attach'), { shell_id: shellId, pty_id: shellId, connection_id: manager.id, rows: 24, cols: 80 });

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

  it('watchdog respawns the bare shell (attach → reattached) after a restart', async () => {
    // 1. Start a real /bin/sh PTY. shell_id must be a UUID — the SDK validates it
    //    as a type-id when dispatching pty_output_msg, else the echo is dropped.
    //    connection_id in the body routes live output to our (live) WS.
    shellId = uuidv4();
    await sdk.apiClient.post(
      termUrl('start'),
      { shell_id: shellId, connection_id: manager.id, rows: 24, cols: 80 },
      60_000,
    );

    // 2. Baseline: input echoes back over the WS (output path is healthy).
    await sendInput("printf 'MARK_BEFORE_OK\\n'\n");
    await waitForEcho(manager, shellId, 'MARK_BEFORE_OK', 15_000);

    // 3. Restart the backend (synchronous; kills the PTY children + clears the
    //    in-memory PtyState). The fresh backend boots the recovery watchdog.
    execFileSync('scripts/instance_ctl.sh', ['launch', 'dev-1'], { cwd: REPO_ROOT, stdio: 'ignore' });

    // 4. Re-init the compute node provider so the PTY can rebind on the node.
    await cn.setup();

    // 4b. Re-watch the bare shell against the FRESH backend. PTY recovery is
    //     ON-DEMAND, not a global sweep (see pty_recovery.py + commit bd14a1ab
    //     "recover on-demand, not a global sweep (out-of-pty-devices crash)"):
    //     `run_pty_recovery` early-returns when nothing is watched, and
    //     `_recover_bare_shells` skips any shell whose `shell:<id>` key isn't in
    //     the watch set. A real terminal UI re-subscribes to its open shell on
    //     reconnect; `attach` is a pure read probe and never registers a watch,
    //     so we re-register it here to give the watchdog a reason to respawn the
    //     bare shell — the bare-shell analog of the agentic sibling's
    //     `proc.watch()`. The restart wiped the backend's in-memory watch
    //     registry, so this must run against the new process; it's a REST POST
    //     (no live WS needed), and the watchdog gate only checks that the
    //     `shell:<id>` key is present, independent of connection liveness — the
    //     recovery proof below is likewise HTTP-only.
    await sdk.apiClient.post(`${sdk.GRAPH_API_PREFIX}/shell/${shellId}/watch`, {
      connection_id: manager.id,
    });

    // 5. Poll attach (HTTP — no live WS required) until the watchdog has
    //    respawned the shell. `attach` returns `reattached` only when the PTY
    //    handle exists; after a restart it exists ONLY if `_recover_bare_shells`
    //    rebuilt it (the client never re-`start`s here). That is the proof.
    await vi.waitFor(
      async () => {
        const res: any = await attach();
        const status = res?.content?.status;
        if (status !== 'reattached') {
          throw new Error(`PTY not recovered yet (status=${status ?? 'none'})`);
        }
      },
      { timeout: 45_000, interval: 2_000 },
    );

    const final: any = await attach();
    expect(final?.content?.status).toBe('reattached');
  }, 120_000);
});
