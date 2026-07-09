/**
 * Bug A regression (bare-shell variant) — an already-open /bin/sh pane must
 * keep rendering after a backend-only restart, with NO reload and NO manual
 * re-attach. Same mechanism and fix as the agentic sibling: membership lives
 * in the backend's memory, a restart wipes it, PtyConnection's self-healing
 * hooks (on_reconnected / on_recovered) re-issue the attach.
 *
 * OFFICIAL CLIENT ONLY (rca skill rule 6): apiTestSetup + tier config.
 *
 *     scripts/instance_ctl.sh launch dev-1
 *     FLOW_INSTANCE=dev-1 npx vitest run --project api \
 *         tests/api/pty_echo_after_backend_restart.test.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, Shell, apiClient, dataContext, GRAPH_API_PREFIX } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
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

const suite = INSTANCE_READY ? describe : describe.skip;

suite(`Bare-shell pane echo after backend restart (official client, instance=${INSTANCE || 'unset'})`, () => {
  const info = getTestSignupInfo();
  let cnId: string;
  const shellId = uuidv4();
  let pane: Shell;

  const termUrl = (op: string) => `${GRAPH_API_PREFIX}/compute_node/${cnId}/terminal-command/${op}`;
  const sendInput = (data: string) => apiClient.post(termUrl('input'), { shell_id: shellId, data });
  const watchShell = () =>
    apiClient.post(`${GRAPH_API_PREFIX}/shell/${shellId}/watch`, {
      connection_id: ConnectionManager.getInstance().id,
    });

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    cnId = dataContext.bootstrapInfo?.default_compute_node?.id;
    expect(cnId, 'default compute node from bootstrap').toBeTruthy();
  });

  it('echo keeps reaching the already-attached pane after restart (self-healing attach)', async () => {
    const manager = ConnectionManager.getInstance();

    // 1. Real /bin/sh PTY + the PANE (Shell + PtyConnection attach) + baseline.
    await apiClient.post(
      termUrl('start'),
      { shell_id: shellId, connection_id: manager.id, rows: 24, cols: 80 },
      60_000,
    );
    pane = new Shell({ id: shellId, compute_node_id: cnId });
    await pane.attachPty({ ptyId: shellId, cols: 80, rows: 24 });
    await sendInput("printf 'MARK_BEFORE\\n'\n");
    await waitForEcho(manager, shellId, 'MARK_BEFORE', 15_000);
    await watchShell(); // what the app's watch layer holds for an open pane

    // 2. Backend-only restart; pane stays mounted, no manual attach below.
    restartBackendOnly();

    // 3. Auto-reconnect (bug B's fix), then re-register the watch the way the
    //    UI does on reconnect — arms on-demand bare-shell recovery.
    await vi.waitFor(
      () => {
        if (!ConnectionManager.getInstance().connected) throw new Error('ws not reconnected');
      },
      { timeout: 40_000, interval: 1_000 },
    );
    await watchShell();

    // 4. THE CONTRACT: once recovery respawns the shell, typing must render —
    //    input is also the readiness probe (it never attaches the caller).
    await vi.waitFor(
      async () => {
        await sendInput("printf 'MARK_AFTER\\n'\n"); // 500 while PTY still dead
        await waitForEcho(manager, shellId, 'MARK_AFTER', 5_000);
      },
      { timeout: 45_000, interval: 1_000 },
    );
  }, 180_000);

  it('control: an explicit forced attach also restores echo', async () => {
    const manager = ConnectionManager.getInstance();
    await pane.attachPty({ ptyId: shellId, cols: 80, rows: 24, force: true });
    await sendInput("printf 'MARK_CONTROL\\n'\n");
    await waitForEcho(manager, shellId, 'MARK_CONTROL', 15_000);
  }, 60_000);
});
