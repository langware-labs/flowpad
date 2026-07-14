/**
 * Resolve the explicit, disposable FLOW_INSTANCE selected for headless tests.
 *
 * Headless tests write real entities, so they must never guess a developer
 * instance or fall back to the user's default backend. The generated env file,
 * launcher registry, live launcher PID, and bootstrap response must all agree on
 * the same named instance before a test may touch it.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { parseDotEnv } from '../hub/_hub';

// ui/tests/headless → repo root (where instance_ctl writes .env.<name>.local).
const REPO_ROOT = path.resolve(__dirname, '../../..');

async function readEnvFile(file: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await fs.readFile(path.join(REPO_ROOT, file), 'utf-8'));
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readLauncher(instanceName: string): Promise<Record<string, unknown> | null> {
  const flowHome = path.resolve(process.env.FLOW_HOME || path.join(homedir(), '.flow'));
  const launcherPath = path.join(flowHome, 'instances', instanceName, 'launcher.json');
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(launcherPath, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function launcherPidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hasReadyBootstrap(apiUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${apiUrl}/api/v1/graph/bootstrap`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const payload: unknown = await res.json();
    if (!isRecord(payload)) return false;
    const data = isRecord(payload.data) ? payload.data : payload;
    return Array.isArray(data.types) && data.types.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export interface LiveBackend {
  apiUrl: string;
  /** Where the port came from, for the test's log line. */
  source: string;
}

/** Return the selected launched backend, or null when any identity check fails. */
export async function resolveLiveBackend(instanceName: string): Promise<LiveBackend | null> {
  if (!instanceName) return null;
  const inst = await readEnvFile(`.env.${instanceName}.local`);
  const port = inst.LOCAL_SERVER_PORT;
  if (inst.FLOW_INSTANCE !== instanceName || !port || !/^\d+$/.test(port)) return null;

  const launcher = await readLauncher(instanceName);
  if (!launcher) return null;
  const backendPid = Number(launcher.backend_pid);
  const expectedEnvFile = path.join(REPO_ROOT, `.env.${instanceName}.local`);
  const launcherEnvFile = typeof launcher.env_file === 'string' ? path.resolve(launcher.env_file) : '';
  if (
    launcher.name !== instanceName ||
    Number(launcher.backend_port) !== Number(port) ||
    launcherEnvFile !== expectedEnvFile ||
    !Number.isInteger(backendPid) ||
    backendPid <= 0 ||
    !launcherPidIsLive(backendPid)
  ) {
    return null;
  }

  const apiUrl = `http://localhost:${port}`;
  if (!(await hasReadyBootstrap(apiUrl))) return null;
  return {
    apiUrl,
    source: `FLOW_INSTANCE=${instanceName} (.env.${instanceName}.local + launcher.json)`,
  };
}
