/**
 * Resolve the explicit launcher-owned backend selected for React tests.
 *
 * A generated env file alone is stale-able. React's live-SDK tests may write
 * entities and host files, so the instance name, env, launcher registry, port,
 * env-file ownership, and live backend PID must all agree before test modules
 * are allowed to run. This preflight is synchronous and performs no service
 * start, network request, retry, poll, or wait.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { parseDotEnv } from '../hub/_hub';

export const WORKTREE_ROOT = path.resolve(__dirname, '../../..');

interface LauncherRegistry {
  name?: unknown;
  backend_port?: unknown;
  env_file?: unknown;
  backend_pid?: unknown;
}

export interface ReactTestInstance {
  name: string;
  apiUrl: string;
  env: Record<string, string>;
}

function pidIsLive(value: unknown): boolean {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Return the selected backend only when every local ownership check agrees. */
export function resolveReactTestInstance(name: string): ReactTestInstance | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;

  const expectedEnvFile = path.join(WORKTREE_ROOT, `.env.${name}.local`);
  let env: Record<string, string>;
  try {
    env = parseDotEnv(readFileSync(expectedEnvFile, 'utf-8'));
  } catch {
    return null;
  }

  const port = env.LOCAL_SERVER_PORT;
  if (env.FLOW_INSTANCE !== name || !/^\d+$/.test(port || '') || env.VITE_API_URL !== `http://localhost:${port}`) {
    return null;
  }

  const flowHome = path.resolve(process.env.FLOW_HOME || path.join(homedir(), '.flow'));
  let launcher: LauncherRegistry;
  try {
    launcher = JSON.parse(
      readFileSync(path.join(flowHome, 'instances', name, 'launcher.json'), 'utf-8'),
    ) as LauncherRegistry;
  } catch {
    return null;
  }

  const launcherEnvFile = typeof launcher.env_file === 'string' ? path.resolve(launcher.env_file) : '';
  if (
    launcher.name !== name ||
    Number(launcher.backend_port) !== Number(port) ||
    launcherEnvFile !== expectedEnvFile ||
    !pidIsLive(launcher.backend_pid)
  ) {
    return null;
  }

  return { name, apiUrl: `http://localhost:${port}`, env };
}
