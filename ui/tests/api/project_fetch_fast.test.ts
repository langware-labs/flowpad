/**
 * Fast-iteration SLO harness for the `/api/v1/graph/project` hang.
 *
 *   1. start an isolated backend instance (own data dir / port, no hub, no frontend)
 *   2. fetch GET /api/v1/graph/project
 *   3. assert it completes within 3s — enforced by AbortSignal.timeout(SLO_MS),
 *      so a hang aborts the fetch and FAILS the test (that 3s cap is the SLO
 *      under test — do not raise it).
 *
 * Default instance `projfast` is fresh/empty (fast, CI-safe). To reproduce the
 * real hang against your live project data, point it at the oss instance:
 *
 *   TEST_INSTANCE=oss TEST_PORT=6079 npx vitest run --project api project_fetch_fast
 *
 * The server-boot wait in beforeAll is setup (cold `uv run` import), NOT the SLO.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = process.env.TEST_INSTANCE || 'projfast';
const PORT = Number(process.env.TEST_PORT || 6077);
const SLO_MS = 3000; // /project must answer within this — the assertion. Do not raise.

let proc: ChildProcess | undefined;

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

beforeAll(async () => {
  const logPath = `/tmp/project_fetch_fast.${INSTANCE}.log`;
  const logHandle = await fs.open(logPath, 'w');
  try {
    proc = spawn('uv', ['run', '-m', 'flow_sdk.server.run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FLOW_INSTANCE: INSTANCE,
        LOCAL_SERVER_PORT: String(PORT),
        MINIHUB_RELOAD: 'False', // single process, no watchfiles
        FLOWPAD_SKIP_DOTENV: 'true', // honor the env we pin here, not .env.local
        FLOWPAD_SKIP_LOCK: 'true', // don't fight the desktop app's singleton lock
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close();
  }
  const up = await waitHealthy(PORT, 60_000); // server-boot budget (setup, not the SLO)
  if (!up) {
    throw new Error(`backend '${INSTANCE}' did not come up on :${PORT} — see ${logPath}`);
  }
}, 65_000);

afterAll(() => {
  proc?.kill('SIGTERM');
});

describe('project fetch SLO', () => {
  it(`GET /api/v1/graph/project answers within ${SLO_MS}ms`, async () => {
    const t0 = performance.now();
    const res = await fetch(`http://localhost:${PORT}/api/v1/graph/project`, {
      signal: AbortSignal.timeout(SLO_MS),
    });
    const ms = Math.round(performance.now() - t0);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string; data?: unknown[] };
    expect(body.status).toBe('SUCCESS');
    // eslint-disable-next-line no-console
    console.log(`[project-fetch] instance=${INSTANCE} ${ms}ms ${body.data?.length ?? '?'} projects`);
  });
});
