/**
 * Recovery test (agentic process variant of pty_survives_restart):
 *
 * 1. Start a real agentic process (claude worker — NOT a bare shell).
 * 2. Restart the backend (kills the worker child).
 * 3. The backend dead-worker watchdog (`run_pty_recovery`) respawns it
 *    (`proc.start_pty()` with `--resume`).
 *
 * Recovery is asserted server-side via the read-only `os-status` GET action:
 * `worker_alive` flips back to true once the watchdog has re-spawned the worker
 * PID (the action self-heals the compute-node binding but never spawns), so it
 * is the single source of truth for "is this thing alive again?" — far more
 * robust than racing the `recovered_msg` push, whose delivery depends on a
 * client watching at the exact instant of recovery.
 *
 * Unlike a bare /bin/sh, an AgenticProcess IS covered by `run_pty_recovery`
 * (it iterates `AgenticProcess.get_all()` and re-`start_pty()`s dead workers),
 * so this recovers server-side with no client re-open.
 *
 * Runs against the disposable `dev-1` instance (skips if not launched), restarts
 * it via instance_ctl — never touches the main :9007 backend.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ENV_FILE = path.join(REPO_ROOT, '.env.dev-1.local');
const PORT = (() => {
  if (!existsSync(ENV_FILE)) return null;
  const m = readFileSync(ENV_FILE, 'utf8').match(/^LOCAL_SERVER_PORT=(\d+)/m);
  return m ? m[1] : null;
})();

const suite = PORT ? describe : describe.skip;

suite('Agentic process survives server restart (dev-1)', () => {
  let sdk: any;
  let manager: any;

  beforeAll(async () => {
    (globalThis as any).__FLOWPAD_API_URL__ = `http://localhost:${PORT}`;
    vi.resetModules();
    sdk = await import('@sdk');

    const info = await sdk.dataManager.bootstrap('localhost', true);
    await sdk.dataManager.loadTypes(info.types || []);
    manager = sdk.ConnectionManager.getInstance();
    if (!manager.connected) await manager.connect();

    // Compute node context (AgenticProcess.start resolves the node from context).
    if (info.default_compute_node) {
      const cn = new sdk.ComputeNode(info.default_compute_node);
      cn.markAsExpanded?.();
      await sdk.dataContext.setContextEntityTypeId(
        sdk.ContextEntitiesEnum.CurrentComputeNodeTypeId,
        cn.typeId,
      );
    }
  }, 60_000);

  it('worker is respawned by the watchdog (os-status worker_alive) after a restart', async () => {
    // 1. Open a real claude tab — the watchdog only recovers VISIBLE, RUNNING
    //    processes, which is exactly what openTab creates ({ visible: true }).
    const proc = await sdk.AgenticProcess.openTab('claude_code', 'stay open and wait');
    expect(proc?.shell_id ?? proc?.id).toBeTruthy();

    const osStatusUrl = `${sdk.GRAPH_API_PREFIX}/${sdk.AgenticProcess.type}/${proc.id}/os-status`;
    const osStatus = () => sdk.apiClient.get(osStatusUrl);

    // Ensure it's actually RUNNING with a live worker before we restart (else the
    // watchdog skips it / there's nothing to prove was recovered).
    await vi.waitFor(
      async () => {
        const s: any = await osStatus();
        if (!s?.worker_alive) {
          throw new Error(`worker not alive yet (status=${s?.status}, ready=${s?.ready})`);
        }
      },
      { timeout: 40_000, interval: 1_000 },
    );

    // 2. Restart the backend (synchronous; kills the worker child).
    execFileSync('scripts/instance_ctl.sh', ['launch', 'dev-1'], { cwd: REPO_ROOT, stdio: 'ignore' });

    // 3. Reconnect to the fresh backend.
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('ws not reconnected');
      },
      { timeout: 40_000, interval: 1_000 },
    );

    // 3b. Re-watch the process on the fresh connection. PTY recovery is
    //     ON-DEMAND, not a global sweep (see pty_recovery.py + commit bd14a1ab
    //     "recover on-demand, not a global sweep (out-of-pty-devices crash)"):
    //     the watchdog only respawns a process a live connection is actively
    //     watching. A real UI re-subscribes to its open tab on reconnect; this
    //     re-registers that watch so the watchdog has a reason to recover.
    await proc.watch();

    // 4. The dead-worker watchdog (~5s interval) should respawn the worker —
    //    os-status `worker_alive` flips back to true once the PID is live again.
    await vi.waitFor(
      async () => {
        const s: any = await osStatus();
        if (!s?.worker_alive) {
          throw new Error(`worker not recovered yet (status=${s?.status}, ready=${s?.ready})`);
        }
      },
      { timeout: 60_000, interval: 2_000 },
    );

    const final: any = await osStatus();
    expect(final.worker_alive).toBe(true);
  }, 180_000);
});
