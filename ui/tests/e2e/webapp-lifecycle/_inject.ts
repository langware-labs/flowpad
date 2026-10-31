/** Fault injection for the scenarios: kill a process, hold a port, corrupt an install marker. */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sigkill(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Hold `port` on 127.0.0.1 with a plain `python3 -m http.server`; resolves once it listens. */
export async function occupyPort(port: number): Promise<ChildProcess> {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) });
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill('SIGKILL');
  throw new Error(`could not occupy port ${port}`);
}

export function release(child: ChildProcess | null | undefined): void {
  if (child && child.exitCode === null) child.kill('SIGKILL');
}

/** Truncate the dev-ok install marker: serve.py then refuses to start. */
export function truncateInstallMarker(appDir: string): void {
  writeFileSync(join(appDir, '.installed', 'marker.json'), '');
}

/** dev-ok's /health answers 404 while this file exists. */
export function failHealth(appDir: string, on = true): void {
  const f = join(appDir, '.fail_health');
  if (on) writeFileSync(f, '1');
  else rmSync(f, { force: true });
}
