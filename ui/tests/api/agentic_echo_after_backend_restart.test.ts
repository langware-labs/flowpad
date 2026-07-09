/**
 * Bug A regression — an already-open AGENTIC pane must keep rendering after a
 * backend-only restart, with NO reload and NO manual re-attach.
 *
 * Mechanism (browser-proven): connection membership lives only in the
 * backend's in-memory PtyRegistry; a restart wipes it and the recovery
 * watchdog respawns the worker with no attached connections. The fix makes
 * PtyConnection re-issue the attach on `on_reconnected` / `on_recovered`
 * (see ptyConnection.ts "Self-healing membership").
 *
 * OFFICIAL CLIENT ONLY (rca skill rule 6): apiTestSetup + the tier's own
 * config. Run against a disposable instance:
 *
 *     scripts/instance_ctl.sh launch dev-1
 *     FLOW_INSTANCE=dev-1 npx vitest run --project api \
 *         tests/api/agentic_echo_after_backend_restart.test.ts
 *
 * The pane is the real SDK stack — Shell + PtyConnection.attach() — and the
 * echo assertion is transport-level (pty_output_msg reaching this
 * connection), which is exactly the link the bug severed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, ConnectionManager, Shell, apiClient, dataContext, GRAPH_API_PREFIX } from '@sdk';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const INSTANCE = process.env.FLOW_INSTANCE || '';
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ENV_FILE = path.join(REPO_ROOT, `.env.${INSTANCE}.local`);
const LAUNCHER = path.join(os.homedir(), `.flow/instances/${INSTANCE}/launcher.json`);
const BACKEND_LOG = path.join(os.homedir(), `.flow/instances/${INSTANCE}/launcher-backend.log`);
const PORT = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').match(/^LOCAL_SERVER_PORT=(\d+)/m)?.[1] : null;

const INSTANCE_READY = (() => {
  if (!INSTANCE || !PORT || !existsSync(LAUNCHER) || !existsSync(BACKEND_LOG)) return false;
  try {
    execFileSync('curl', ['-sf', '--max-time', '2', `http://localhost:${PORT}/api/v1/health/status`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

function restartBackendOnly(): void {
  const script = `
    set -e
    PID=$(python3 -c "import json;print(json.load(open('${LAUNCHER}'))['backend_pid'])")
    kill -TERM "$PID" 2>/dev/null || true
    for i in $(seq 1 30); do curl -s -o /dev/null --max-time 1 http://localhost:${PORT}/api/v1/health/status || break; sleep 0.5; done
    set -a; source '${ENV_FILE}'; set +a
    cd '${REPO_ROOT}'
    nohup uv run -m flow_sdk.server.run >> '${BACKEND_LOG}' 2>&1 &
    NEWPID=$!
    python3 - "$NEWPID" <<'EOF'
import json, sys
reg = json.load(open('${LAUNCHER}'))
reg['backend_pid'] = int(sys.argv[1])
json.dump(reg, open('${LAUNCHER}', 'w'), indent=2)
EOF
    for i in $(seq 1 60); do curl -s -o /dev/null --max-time 1 http://localhost:${PORT}/api/v1/health/status && exit 0; sleep 1; done
    echo "backend did not come back" >&2; exit 1
  `;
  execFileSync('bash', ['-c', script], { stdio: 'inherit' });
}

/** Strip ANSI escape sequences so TUI redraws don't split the marker. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

function decodePtyData(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Transport-level echo: the pty_output_msg chunks reaching THIS connection. */
function waitForEcho(manager: any, shellId: string, keyword: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let acc = '';
    const handler = (msg: any) => {
      if (msg.shell_id !== shellId) return;
      acc += decodePtyData(msg.data);
      if (stripAnsi(acc).includes(keyword)) {
        clearTimeout(timer);
        manager.off('on_pty_output_msg', handler);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      manager.off('on_pty_output_msg', handler);
      reject(
        new Error(`Timeout waiting for "${keyword}". Stripped tail: ${JSON.stringify(stripAnsi(acc).slice(-200))}`),
      );
    }, timeoutMs);
    manager.on('on_pty_output_msg', handler);
  });
}

const suite = INSTANCE_READY ? describe : describe.skip;

suite(`Agentic pane echo after backend restart (official client, instance=${INSTANCE || 'unset'})`, () => {
  const info = getTestSignupInfo();
  let cnId: string;
  let proc: any;
  let shellId: string;
  let pane: Shell;

  const termUrl = (op: string) => `${GRAPH_API_PREFIX}/compute_node/${cnId}/terminal-command/${op}`;
  const sendInput = (data: string) => apiClient.post(termUrl('input'), { shell_id: shellId, data });

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    cnId = dataContext.bootstrapInfo?.default_compute_node?.id;
    expect(cnId, 'default compute node from bootstrap').toBeTruthy();
  });

  it('echo keeps reaching the already-attached pane after restart (self-healing attach)', async () => {
    const manager = ConnectionManager.getInstance();

    // 1. Real claude tab, worker alive; shell_id arrives once the PTY spawns.
    proc = await AgenticProcess.openTab('claude_code', 'stay open and wait');
    const osStatusUrl = `${GRAPH_API_PREFIX}/${AgenticProcess.type}/${proc.id}/os-status`;
    await vi.waitFor(
      async () => {
        const s: any = await apiClient.get(osStatusUrl);
        if (!s?.worker_alive || !s?.shell_id) throw new Error('worker not alive yet');
        shellId = s.shell_id;
      },
      { timeout: 60_000, interval: 1_000 },
    );

    // 2. The PANE: real Shell + PtyConnection attach (what a mounted terminal
    //    does), then baseline echo over the live transport.
    pane = new Shell({ id: shellId, compute_node_id: cnId });
    await pane.attachPty({ ptyId: shellId, cols: 80, rows: 24 });
    await sendInput('BASELINE_MARK');
    await waitForEcho(manager, shellId, 'BASELINE_MARK', 20_000);

    // 3. Backend-only restart. The pane stays "mounted": no loader re-run, no
    //    manual attach from here on — the SDK must self-heal.
    restartBackendOnly();

    // 4. The client's own machinery reconnects (bug B's fix) and the UI's
    //    watch layer re-registers on reconnect — mirror that one call.
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('ws not reconnected');
      },
      { timeout: 40_000, interval: 1_000 },
    );
    await proc.watch();

    // 5. Watchdog respawns the worker (HTTP probe, never attaches us).
    await vi.waitFor(
      async () => {
        const s: any = await apiClient.get(osStatusUrl);
        if (!s?.worker_alive) throw new Error('worker not recovered yet');
      },
      { timeout: 60_000, interval: 2_000 },
    );

    // 6. THE CONTRACT: typing renders to the already-open pane — the
    //    PtyConnection re-attach hooks must have restored membership.
    await vi.waitFor(
      async () => {
        await sendInput('MARK_AFTER_RESTART');
        await waitForEcho(manager, shellId, 'MARK_AFTER_RESTART', 5_000);
      },
      { timeout: 30_000, interval: 1_000 },
    );
  }, 240_000);

  it('control: an explicit forced attach also restores echo', async () => {
    const manager = ConnectionManager.getInstance();
    await pane.attachPty({ ptyId: shellId, cols: 80, rows: 24, force: true });
    await sendInput('MARK_CONTROL');
    await waitForEcho(manager, shellId, 'MARK_CONTROL', 20_000);
  }, 60_000);
});
