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
import { execFile, spawn } from 'node:child_process';
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

async function readRegistry(name: string): Promise<{ backend_port: number; backend_pid: number } | null> {
  try {
    return JSON.parse(await fs.readFile(registryPath(name), 'utf-8'));
  } catch {
    return null;
  }
}

function sh(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: REPO_ROOT, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error && typeof (error as any).code === 'number' ? (error as any).code : error ? 1 : 0, out: stdout, err: stderr });
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

async function waitPortClosed(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/api/v1/graph/bootstrap`, { signal: AbortSignal.timeout(1000) });
    } catch {
      return true; // connection refused / timeout → port is down
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Launch a dedicated instance (frontend + backend) and wait for backend health.
 *  Returns the backend port, or null if launch/health failed (caller skips). */
export async function launchInstance(name: string, budgetMs = 90_000): Promise<number | null> {
  await sh('bash', [INSTANCE_CTL, 'kill', name], 15_000); // idempotent clean slate
  const res = await sh('bash', [INSTANCE_CTL, 'launch', name], budgetMs);
  const reg = await readRegistry(name);
  if (!reg) {
    // eslint-disable-next-line no-console
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

/** Bounce ONLY the backend: kill its PID, re-spawn `uv run -m flow_sdk.server.run`
 *  detached with the instance's own env, wait for health on the same port.
 *  Returns the (unchanged) backend port, or null on failure. */
export async function restartBackend(name: string, budgetMs = 60_000): Promise<number | null> {
  const reg = await readRegistry(name);
  if (!reg) return null;
  try {
    process.kill(reg.backend_pid, 'SIGTERM');
  } catch {
    /* already dead */
  }
  await waitPortClosed(reg.backend_port, 15_000);

  const envFile = path.join(REPO_ROOT, `.env.${name}.local`);
  const logPath = path.join(flowHome(), 'instances', name, 'restart-backend.log');
  const logHandle = await fs.open(logPath, 'a');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      'bash',
      ['-c', `set -a; source '${envFile}'; set +a; cd '${REPO_ROOT}'; exec uv run -m flow_sdk.server.run`],
      { cwd: REPO_ROOT, detached: true, stdio: ['ignore', logHandle.fd, logHandle.fd] },
    );
  } finally {
    await logHandle.close();
  }
  child.unref();
  // Update the registry so a later kill/restart targets the new backend.
  try {
    await fs.writeFile(registryPath(name), JSON.stringify({ ...reg, backend_pid: child.pid }, null, 2));
  } catch {
    /* best effort */
  }
  return (await waitHealthy(reg.backend_port, budgetMs)) ? reg.backend_port : null;
}
