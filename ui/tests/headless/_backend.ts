/**
 * Resolve a LIVE backend for the headless tests — no mocks, ever.
 *
 * Order of preference:
 *   1. An `instance_ctl` instance (default `dev-1`) if it's been launched —
 *      `.env.<name>.local` carries its `LOCAL_SERVER_PORT`. This is the isolated,
 *      reproducible target (own DB + hub user), matching the hub harness.
 *   2. The default dev backend from the repo-root `.env.local`
 *      (`LOCAL_SERVER_PORT`) — i.e. whatever `uv run -m flow_sdk.server.run` is
 *      serving.
 *
 * Either way we health-ping `/health/status` before returning; if nothing is
 * reachable we return `null` and the test skips itself (the same posture the hub
 * tests take when the hub is down — a smoke test must not fail just because no
 * backend happens to be running locally).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseDotEnv } from '../hub/_hub';

// ui/tests/headless → repo root (where .env.local and .env.<name>.local live).
const REPO_ROOT = path.resolve(__dirname, '../../..');

async function readEnvFile(file: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await fs.readFile(path.join(REPO_ROOT, file), 'utf-8'));
  } catch {
    return {};
  }
}

async function isHealthy(apiUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${apiUrl}/health/status`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export interface LiveBackend {
  apiUrl: string;
  /** Where the port came from, for the test's log line. */
  source: string;
}

/**
 * Return the first reachable backend, or `null` if none is up.
 * Pass an explicit instance name to prefer it (default `dev-1`).
 */
export async function resolveLiveBackend(instanceName = 'dev-1'): Promise<LiveBackend | null> {
  const candidates: Array<{ apiUrl: string; source: string }> = [];

  const inst = await readEnvFile(`.env.${instanceName}.local`);
  if (inst.LOCAL_SERVER_PORT) {
    candidates.push({
      apiUrl: `http://localhost:${inst.LOCAL_SERVER_PORT}`,
      source: `instance ${instanceName} (.env.${instanceName}.local)`,
    });
  }

  const root = await readEnvFile('.env.local');
  if (root.LOCAL_SERVER_PORT) {
    candidates.push({
      apiUrl: `http://localhost:${root.LOCAL_SERVER_PORT}`,
      source: 'default dev backend (.env.local)',
    });
  }

  for (const c of candidates) {
    if (await isHealthy(c.apiUrl)) return c;
  }
  return null;
}
