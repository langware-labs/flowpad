/**
 * PTY recovery after a real backend restart — ALL worker types (TDD).
 *
 * A PTY worker is a child of the backend; killing the backend kills it. This
 * brings up a dedicated isolated instance, runs one worker of EACH type to a
 * live PTY, KILLS the backend once, restarts it, and demands every session be
 * FULLY RECOVERED:
 *   - the backend pushes a distinct `recovered` event the SDK observes,
 *   - os-status reports ready/worker_alive again,
 *   - the worker PID is genuinely fresh (≠ pre-restart),
 *   - the pre-restart scrollback survived (framed .pty replay).
 *
 * A worker type that can't start on this host (binary absent) is skipped, not
 * failed — but at least one must start or the test is meaningless.
 *
 * Skips entirely when the instance can't be launched (infra absent).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInstance, type ResolvedInstance } from '../hub/_instances';
import { killInstance, launchInstance, restartBackend } from './_backend_lifecycle';

const INSTANCE = 'ptyrec-1';
const WORKER_TYPES = ['claude', 'codex', 'copilot'] as const;
const TIMEOUT = 240_000; // long-test cap — the ceiling, never to be raised
const POLL_MS = 100;
const POLL_BUDGET_MS = 25_000;

let inst: ResolvedInstance | null = null;

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(async () => {
  const port = await launchInstance(INSTANCE);
  if (port == null) return;
  inst = await getInstance(INSTANCE);
}, TIMEOUT);

afterAll(async () => {
  await killInstance(INSTANCE);
});

interface Started {
  workerType: string;
  proc: any;
  oldWorkerPid: number | null;
  scrollbackBefore: string;
}

/** Decode a framed pty-stream's output frames to the raw byte string. */
function decodeStream(stream: any): string {
  const events: any[] = stream?.events ?? [];
  let out = '';
  for (const ev of events) {
    if (ev[0] === 'o' && typeof ev[1] === 'string') {
      out += Buffer.from(ev[1], 'base64').toString('binary');
    }
  }
  return out;
}

describe('PTY survives a backend restart (recovery watchdog)', () => {
  it('fully recovers every worker type after one backend kill+restart', async () => {
    if (!inst) {
      // eslint-disable-next-line no-console
      console.warn(`[pty-recovery] instance '${INSTANCE}' unavailable — skipping`);
      return;
    }
    const { sdk } = inst;

    // OS-level status snapshot. The frontend SDK no longer probes os-status
    // (recovery is fully backend-owned — see agentic-process.ts header), so
    // read it straight off the still-live per-process `os-status` action,
    // exactly as the pty-stream reads below do. Payload shape:
    // { ready, worker_alive, has_attachable_pty, worker_pid, shell_id, ... }.
    const osStatus = (proc: any) =>
      sdk.apiClient.get<any>(`${sdk.GRAPH_API_PREFIX}/${sdk.AgenticProcess.type}/${proc.id}/os-status`);

    // observe the distinct `recovered` event (persists across reconnect)
    const recovered: Array<{ process_id?: string }> = [];
    sdk.connectionManager.on('on_recovered', (msg: any) => recovered.push(msg));

    // ── start one visible worker of each type that this host can run ──
    const started: Started[] = [];
    for (const workerType of WORKER_TYPES) {
      try {
        // The entity's worker_type is the WorkerType enum, which has no
        // "claude" member — claude IS the default (unset). codex/copilot are
        // valid enum values and set explicitly.
        const proc = await new sdk.AgenticProcess({
          visible: true,
          ...(workerType === 'claude' ? {} : { worker_type: workerType }),
        }).save([]);
        await proc.start({ visible: true });
        await until(async () => (await osStatus(proc)).ready === true, `${workerType} ready`);
        const os = await osStatus(proc);
        // Wait for the worker's banner to flush to the .pty so there is real
        // scrollback to track across the restart (ready ≠ output-flushed).
        await until(
          async () => decodeStream(await sdk.apiClient.get<any>(`/shell/${os.shell_id}/pty-stream`)).length > 0,
          `${workerType} produced scrollback`,
        );
        const streamBefore = await sdk.apiClient.get<any>(`/shell/${os.shell_id}/pty-stream`);
        started.push({ workerType, proc, oldWorkerPid: os.worker_pid, scrollbackBefore: decodeStream(streamBefore) });
        // eslint-disable-next-line no-console
        console.log(`[pty-recovery] started ${workerType} (worker_pid=${os.worker_pid}, shell=${os.shell_id}, scrollback=${decodeStream(streamBefore).length}B)`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[pty-recovery] ${workerType} did not start on this host — skipping:`, (e as Error).message);
      }
    }
    expect(started.length, 'at least one worker type started').toBeGreaterThan(0);
    for (const s of started) {
      expect(s.scrollbackBefore.length, `${s.workerType} has scrollback before`).toBeGreaterThan(0);
    }

    // ── one kill + restart for all of them ──
    const port = await restartBackend(INSTANCE);
    expect(port, 'backend came back healthy').not.toBeNull();

    await sdk.connectionManager.connect();
    for (const s of started) await s.proc.watch();

    // ── every started worker fully recovered ──
    for (const s of started) {
      await until(
        () => recovered.some((r) => r.process_id === s.proc.id),
        `recovered event for ${s.workerType}`,
      );
      // Poll os-status — a recovered worker (esp. claude --resume + MCP init)
      // may take a moment to become psutil-alive after the event.
      await until(async () => (await osStatus(s.proc)).ready === true, `${s.workerType} ready after restart`);
      const after = await osStatus(s.proc);
      expect(after.worker_alive, `${s.workerType} worker alive after restart`).toBe(true);
      expect(after.has_attachable_pty, `${s.workerType} attachable PTY after restart`).toBe(true);
      expect(after.worker_pid, `${s.workerType} worker PID is fresh`).not.toBe(s.oldWorkerPid);
      // Replay-on-recovery: the pre-restart scrollback must survive — the
      // recovered worker appends to the SAME .pty, so the post-restart stream
      // still contains the pre-restart bytes (not just the new banner).
      const streamAfter = decodeStream(await sdk.apiClient.get<any>(`/shell/${after.shell_id}/pty-stream`));
      expect(
        streamAfter.includes(s.scrollbackBefore),
        `${s.workerType} pre-restart scrollback preserved (before=${s.scrollbackBefore.length}B, after=${streamAfter.length}B)`,
      ).toBe(true);
      // eslint-disable-next-line no-console
      console.log(
        `[pty-recovery] recovered ${s.workerType} (worker_pid ${s.oldWorkerPid} → ${after.worker_pid}, ` +
          `scrollback ${s.scrollbackBefore.length}B → ${streamAfter.length}B, preserved)`,
      );
    }
  }, TIMEOUT);
});
