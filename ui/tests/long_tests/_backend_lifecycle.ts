/**
 * Backend lifecycle control for restart/recovery long-tests.
 *
 * Wraps `scripts/instance_ctl.sh` to bring up a dedicated, isolated backend
 * instance (own port / DB / `.pty` dir), and adds a precise `restartBackend`
 * that bounces ONLY the backend process (not the frontend) — mirroring prod,
 * where Flowpad.app respawns just the Python server. The new backend reuses
 * the same instance dir, so it reads the same DB and the same on-disk `.pty`
 * stream files; `run.py` auto-clears the stale singleton lock of the dead PID.
 *
 * Reused by the realm-per-instance harness (`ui/tests/hub/_instances.ts`),
 * which reads the `.env.<name>.local` that `instance_ctl launch` writes.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createSdkMainRealm, type OwnedSdkMainRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INSTANCE_CTL = path.join(REPO_ROOT, 'scripts', 'instance_ctl.sh');

function flowHome(): string {
  return process.env.FLOW_HOME || path.join(process.env.HOME || '', '.flow');
}

function registryPath(name: string): string {
  return path.join(flowHome(), 'instances', name, 'launcher.json');
}

function serverInfoPath(name: string): string {
  return path.join(flowHome(), 'instances', name, 'server.json');
}

async function readRegistry(name: string): Promise<{ backend_port: number; backend_pid: number } | null> {
  try {
    return JSON.parse(await fs.readFile(registryPath(name), 'utf-8'));
  } catch {
    return null;
  }
}

async function readServerInfo(name: string): Promise<{ port: number; server_pid: number } | null> {
  try {
    return JSON.parse(await fs.readFile(serverInfoPath(name), 'utf-8'));
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sh(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: REPO_ROOT, timeout: timeoutMs }, (error, stdout, stderr) => {
      const errorCode = error?.code;
      resolve({
        code: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
        out: stdout,
        err: stderr,
      });
    });
  });
}

async function waitHealthy(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/graph/bootstrap`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function waitHealthyOwned(
  name: string,
  port: number,
  wrapperPid: number,
  previousServerPid: number,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const [registry, server] = await Promise.all([readRegistry(name), readServerInfo(name)]);
    if (
      registry?.backend_pid === wrapperPid &&
      server?.port === port &&
      server.server_pid > 0 &&
      server.server_pid !== previousServerPid &&
      pidIsAlive(wrapperPid) &&
      pidIsAlive(server.server_pid)
    ) {
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/graph/bootstrap`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        /* owner is not healthy yet */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Launch a dedicated instance (frontend + backend) and wait for backend health.
 *  Returns the backend port, or null if launch/health failed. */
export async function launchInstance(name: string, budgetMs = 90_000): Promise<number | null> {
  await sh('bash', [INSTANCE_CTL, 'kill', name], 15_000); // idempotent clean slate
  const res = await sh('bash', [INSTANCE_CTL, 'launch', name], budgetMs);
  const reg = await readRegistry(name);
  if (!reg) {
    console.error(`[backend-lifecycle] launch ${name} produced no registry:\n${res.out}\n${res.err}`);
    return null;
  }
  return (await waitHealthy(reg.backend_port, 30_000)) ? reg.backend_port : null;
}

export async function killInstance(name: string): Promise<void> {
  await sh('bash', [INSTANCE_CTL, 'kill', name], 15_000);
}

/**
 * Give the next `import('@sdk')` a clean, isolated realm pointed at `port`:
 * reset the SHARED jsdom window/global state, repoint the runtime API url, drop
 * the module registry, then re-import the SDK graph + its `main` entrypoint
 * (both resolve into the same fresh realm, sharing its singletons).
 */
export async function prepareCleanRealm(port: number): Promise<OwnedSdkMainRealm> {
  // Wipe the shared window context so this instance doesn't inherit the prior run's
  // persisted context entities / appReady flag.
  try {
    window.localStorage.clear();
  } catch {
    /* no localStorage in this env */
  }
  delete (window as Record<string, unknown>).appReady;
  delete (window as Record<string, unknown>).context;
  delete (window as Record<string, unknown>).sniffer;

  return createSdkMainRealm(`http://localhost:${port}`);
}

/** Bounce ONLY the backend through the instance lifecycle owner, which reaps
 *  the recorded process tree and exact-instance strays before re-spawning.
 *  Instance data is preserved, including the graph and on-disk PTY streams.
 *  Returns the (unchanged) backend port, or null on failure. */
export async function restartBackend(name: string, budgetMs = 60_000): Promise<number | null> {
  const reg = await readRegistry(name);
  const previousServer = await readServerInfo(name);
  if (!reg || !previousServer || previousServer.port !== reg.backend_port) return null;
  const restart = await sh('uv', ['run', 'flow', 'instance', 'restart-backend', name, '--json'], 15_000);
  if (restart.code !== 0) {
    console.error(`[backend-lifecycle] restart ${name} failed:\n${restart.out}\n${restart.err}`);
    return null;
  }
  let summary: { instance?: string; killed_pids?: number[]; backend_pid?: number };
  try {
    summary = JSON.parse(restart.out);
  } catch {
    return null;
  }
  const backendPid = summary.backend_pid;
  if (
    summary.instance !== name ||
    typeof backendPid !== 'number' ||
    !Number.isInteger(backendPid) ||
    backendPid <= 0 ||
    !summary.killed_pids?.includes(reg.backend_pid) ||
    !summary.killed_pids.includes(previousServer.server_pid)
  ) {
    return null;
  }
  return (await waitHealthyOwned(
    name,
    reg.backend_port,
    backendPid,
    previousServer.server_pid,
    budgetMs,
  ))
    ? reg.backend_port
    : null;
}
