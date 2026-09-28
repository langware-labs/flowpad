/**
 * Driving the app through the REAL control plane (`flow navigate`, `flow show`) —
 * shared by the dock sweep and the navigation specs.
 */
import { execFileSync } from 'child_process';
import { expect, type Page } from '@playwright/test';
import { REPO_ROOT } from './api';

/** Run a flow CLI verb against `instance` (default: this run's FLOW_INSTANCE). */
export function flow(args: string[], instance = process.env.FLOW_INSTANCE ?? ''): { code: number; out: string } {
  try {
    const out = execFileSync('uv', ['run', 'flow', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, FLOW_INSTANCE: instance },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Wait until the backend can steer THIS page. A single 200 from
 * `/api/v1/agent/context` is not enough: right after a `goto`, the previous page's
 * dying socket still answers, then is reaped before the CLI runs (`No active tab`).
 * Settled means the SAME connection answered twice and the page did not navigate
 * between the answers — a dying registration cannot survive both reads.
 */
export async function awaitSteerable(page: Page, backend: string): Promise<void> {
  let lastCid: string | null = null;
  let lastUrl: string | null = null;
  await expect
    .poll(
      async () => {
        const urlBefore = page.url();
        const r = await fetch(`${backend}/api/v1/agent/context`);
        if (r.status !== 200) {
          lastCid = lastUrl = null;
          return false;
        }
        const cid = ((await r.json()) as { connection_id?: string }).connection_id ?? null;
        const settled = cid !== null && cid === lastCid && urlBefore === lastUrl && page.url() === urlBefore;
        lastCid = cid;
        lastUrl = urlBefore;
        return settled;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}
