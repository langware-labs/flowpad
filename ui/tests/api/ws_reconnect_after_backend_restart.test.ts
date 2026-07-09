/**
 * Regression capture — Bug B (official api-tier form): the ConnectionManager
 * never re-dials after the backend restarts.
 *
 * A restarting backend sends a proper close frame (1012 "service restart",
 * wasClean=true — spec-correct in every browser). onClose's
 * `if (!event.wasClean)` reads that as an intentional goodbye and permanently
 * disables reconnection: the app keeps talking to the new backend over HTTP
 * (bootstrap, watch, attach, input all succeed) while its WS is gone, so the
 * backend attaches a connection_id it does not hold and PTY output vanishes
 * (now at least logged — see test_pty_output_drop_logging.py).
 *
 * OFFICIAL CLIENT ONLY (rca skill rule 6): no `__FLOWPAD_API_URL__` override —
 * the SDK realm, backend URL, and ConnectionManager all come from the api
 * tier's own config. Run against a disposable instance:
 *
 *     scripts/instance_ctl.sh launch dev-1
 *     FLOW_INSTANCE=dev-1 npx vitest run --project api \
 *         tests/api/ws_reconnect_after_backend_restart.test.ts
 *
 * Skips unless FLOW_INSTANCE names a launched instance (never restarts the
 * default dev backend).
 *
 * Ground truth is backend-recorded: a re-dial MUST produce a
 * "WebSocket endpoint called for connection_id=<id>" line in the instance's
 * backend log. The control test proves the harness + dial path by forcing
 * the re-dial the automatic trigger should have issued.
 *
 * (The second Bug B mode — SILENT transport death, no close event at all —
 * cannot be produced through the official client against a real backend
 * without interposing on the transport; it is verified in the real-Chromium
 * debugMCP record and will be covered by the fix's own verification.)
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionManager } from '@sdk';
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

/** Backend-only restart: SIGTERM the instance's backend, respawn it with the
 *  instance env (appending to the same launcher-backend.log so the ground-
 *  truth grep target stays one file), wait for health. The client realm is
 *  untouched — its reconnect machinery must cope on its own. */
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

/** Backend log appended after `offset` — the backend-recorded ground truth. */
function logSince(offset: number): string {
  const size = statSync(BACKEND_LOG).size;
  if (size <= offset) return '';
  const fd = openSync(BACKEND_LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return buf.toString('utf8');
}

async function pollUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return cond();
}

const redialLine = (cmId: string) => `WebSocket endpoint called for connection_id=${cmId}`;

const suite = INSTANCE_READY ? describe : describe.skip;

suite(`WS reconnect after backend restart (official client, instance=${INSTANCE || 'unset'})`, () => {
  const info = getTestSignupInfo();

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
  });

  it('re-dials the restarted backend on its own (no forced help)', async () => {
    const cm = ConnectionManager.getInstance();
    expect(cm.connected, 'baseline: official client connected').toBe(true);

    const offset = statSync(BACKEND_LOG).size;
    restartBackendOnly();

    // Contract: the client's own machinery must land a NEW WS handshake on
    // the restarted backend. Today it never does — the 1012 close frame is
    // treated as an intentional goodbye (skip_clean_close) and the client
    // zombies while its HTTP keeps working.
    const redialed = await pollUntil(() => logSince(offset).includes(redialLine(cm.id)), 20_000);
    expect(redialed, 'client must re-dial to the restarted backend').toBe(true);
  }, 120_000);

  it('control: a forced re-dial lands on the restarted backend (machinery works)', async () => {
    const cm = ConnectionManager.getInstance();
    const offset = statSync(BACKEND_LOG).size;

    // Force what the automatic trigger should have done.
    try {
      cm.getSocket()?.close();
    } catch {
      /* zombie sockets may throw */
    }
    await cm.connect();

    const redialed = await pollUntil(() => logSince(offset).includes(redialLine(cm.id)), 15_000);
    expect(redialed, 'an explicit re-dial must land — only the TRIGGER is missing').toBe(true);
  }, 60_000);
});
