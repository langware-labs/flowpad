/**
 * Which launched instance this suite drives. Explicit, never a default: the suite seeds projects,
 * kills processes and occupies ports, so it must never land on prod (:9007) or the `oss` checkout.
 *
 *   WL_INSTANCE=<name>      a `scripts/instance_ctl.sh launch <name>` instance (launcher registry)
 *   WL_FE_PORT / WL_BE_PORT override the registry's ports (a worktree's own dev servers)
 *
 * Resolution mirrors `ui/tests/hub/_instances.ts`: the launcher registry is the truth, and both
 * recorded PIDs must be live.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

const FORBIDDEN = new Set(['prod', 'oss']);

export interface WlInstance {
  name: string;
  frontendPort: number;
  backendPort: number;
  backendPid: number | null;
  frontendPid: number | null;
  dir: string;
  apiUrl: string;
  feUrl: string;
}

function pidLive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function flowHome(): string {
  return process.env.FLOW_HOME?.trim() || path.join(homedir(), '.flow');
}

/** Read the launcher registry fresh — `restart-backend` rewrites its backend_pid. */
export function readLauncher(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(flowHome(), 'instances', name, 'launcher.json'), 'utf-8'));
}

/** The instance under test, or an explanation of why there is none (the suite skips on it). */
export function resolveInstance(): WlInstance | string {
  const name = process.env.WL_INSTANCE?.trim() || '';
  if (!name) return 'WL_INSTANCE is not set — launch one: scripts/instance_ctl.sh launch wl-7';
  if (FORBIDDEN.has(name)) return `WL_INSTANCE=${name} is refused: this suite never drives prod or oss`;
  let reg: Record<string, unknown>;
  try {
    reg = readLauncher(name);
  } catch {
    return `instance '${name}' has no launcher registry — launch it with scripts/instance_ctl.sh`;
  }
  if (reg.name !== name) return `launcher registry for '${name}' names '${String(reg.name)}'`;
  const backendPort = Number(process.env.WL_BE_PORT || reg.backend_port);
  const frontendPort = Number(process.env.WL_FE_PORT || reg.frontend_port);
  if (backendPort === 9007 || frontendPort === 9007) return 'port 9007 is prod — refused';
  if (!process.env.WL_BE_PORT && !pidLive(reg.backend_pid)) return `instance '${name}' backend pid is not live`;
  if (!process.env.WL_FE_PORT && !pidLive(reg.frontend_pid)) return `instance '${name}' frontend pid is not live`;
  return {
    name,
    backendPort,
    frontendPort,
    backendPid: Number(reg.backend_pid) || null,
    frontendPid: Number(reg.frontend_pid) || null,
    dir: path.join(flowHome(), 'instances', name),
    apiUrl: `http://localhost:${backendPort}`,
    feUrl: `http://localhost:${frontendPort}`,
  };
}

export const INSTANCE = resolveInstance();
export const instanceOk = (i: WlInstance | string): i is WlInstance => typeof i !== 'string';
