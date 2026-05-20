/**
 * Shared scaffolding for the two-process matrix test
 * (``matrix.alice.test.ts`` ↔ ``matrix.bob.test.ts``).
 *
 * The two halves run as SEPARATE vitest processes against SEPARATE local
 * backends (alice → :9008, bob → :9007). Neither side simulates the other:
 * each drives the real production SDK against its own real backend, and the
 * backends bridge to the shared hub. They coordinate only through:
 *   - the shared hub conversation itself (messages are the channel), and
 *   - one rendezvous file that hands the conv id from alice to bob.
 */
import { promises as fsp } from 'node:fs';

import { HUB_URL } from './_hub';

// Rendezvous file: alice writes the freshly-created conv id here after
// ``share()``; bob polls for it so he targets THIS run's conversation and
// not a stale one from a previous run.
export const RENDEZVOUS = '/tmp/flowpad_matrix_conv.txt';

// _hub.ts's hubAvailable() uses AbortSignal.timeout which jsdom's fetch
// rejects with a type error — probe inline instead.
export async function probeHub(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await fetch(`${HUB_URL}/api/v1/health/status`);
    if (!r.ok) return { ok: false, reason: `hub /health returned ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `hub unreachable: ${String(e)}` };
  }
}

// Confirms the LOCAL backend this process talks to is cloud-logged-in — its
// hub bridge must be live for any cross-user message to flow.
export async function probeLocalBackendLoggedIn(apiBase: string): Promise<{
  ok: boolean;
  email?: string;
}> {
  try {
    const r = await fetch(`${apiBase}/cloud/status`);
    if (!r.ok) return { ok: false };
    const body = (await r.json()) as {
      data?: { logged_in?: boolean; user?: { email?: string } };
    };
    return { ok: body.data?.logged_in === true, email: body.data?.user?.email };
  } catch {
    return { ok: false };
  }
}

// Generic poll: call ``fn`` every 100ms until it returns a truthy value or we
// hit ``timeoutMs``. Returns the truthy value. Used for cross-process waits
// (waiting on a message to arrive, a file to appear, a status to flip).
export async function pollUntil<T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`);
}

// Bob waits for alice to publish the conv id. Returns the conv id string.
export async function readRendezvous(timeoutMs: number): Promise<string> {
  return pollUntil(
    async () => {
      try {
        const txt = (await fsp.readFile(RENDEZVOUS, 'utf-8')).trim();
        return txt.length > 0 ? txt : null;
      } catch {
        return null; // file not written yet
      }
    },
    timeoutMs,
    'rendezvous file',
  );
}

// Alice clears any stale rendezvous file at the start of her run so bob can't
// pick up a conv id from a previous run.
export async function clearRendezvous(): Promise<void> {
  try {
    await fsp.unlink(RENDEZVOUS);
  } catch {
    // already absent — fine
  }
}

// Alice publishes the conv id once the conversation exists + is shared.
export async function writeRendezvous(convId: string): Promise<void> {
  await fsp.writeFile(RENDEZVOUS, convId, 'utf-8');
}
