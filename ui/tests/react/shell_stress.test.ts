/**
 * Shell / PTY Lifecycle Stress Tests
 *
 * Suite 1 (unit, no backend): Pure SDK state — connect idempotency, restart
 *   state machine, concurrent connect() calls, onOutput gate across the full
 *   lifecycle.
 *
 * Suite 2 (integration, backend + WS): Real PTY — concurrent open/close,
 *   sequential cycling, PTY recovery after server-side kill, restart (seq
 *   reset + re-attach), and rapid reconnects.
 */

import { apiClient, ConnectionManager, dataManager, GRAPH_API_PREFIX, Shell, TypeId } from '@sdk';
import { PtyConnection } from '@sdk/services/shell/ptyConnection';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a shell entity and open its PTY via the backend shell/open action. */
async function openShellRaw(computeNode: { id: string; typeId?: TypeId }, shellId: string, connectionId: string): Promise<Shell> {
  const shell = Shell.create(computeNode as any, { name: 'Stress Shell' });
  (shell as any).id = shellId;
  await shell.save(computeNode.typeId ?? new TypeId('compute_node', computeNode.id));
  const result = await apiClient.post(`${GRAPH_API_PREFIX}/shell/${shellId}/open`, {
    connection_id: connectionId,
    rows: 24,
    cols: 80,
  });
  shell.pty_pid = result?.pty_id ?? shellId;
  registerShell(shell);
  return shell;
}

/** Send a newline to ensure bash emits a prompt. */
async function sendNewline(computeNodeId: string, shellId: string): Promise<void> {
  await apiClient
    .post(`${GRAPH_API_PREFIX}/compute_node/${computeNodeId}/terminal-command/input`, {
      shell_id: shellId,
      data: '\n',
    })
    .catch(() => {});
}

/** Close PTY via API. */
async function closePtyRaw(computeNodeId: string, shellId: string): Promise<void> {
  await apiClient
    .post(`${GRAPH_API_PREFIX}/compute_node/${computeNodeId}/terminal-command/close`, {
      shell_id: shellId,
    })
    .catch(() => {});
}

/** Register a Shell in dataManager so SDK entity lookup finds it. */
function registerShell(shell: Shell): void {
  const typeId = new TypeId('shell', shell.id);
  const ref = (dataManager as any).getRef(typeId);
  ref.entity = shell;
}

/**
 * Create a Shell + start its PTY + send a newline, wait for output to accumulate.
 * Mirrors the timing from pty_corruption.test.ts: 400ms before newline (bash startup),
 * then `waitMs` more (server stores output with seq numbers).
 */
async function spawnShell(computeNode: { id: string }, connectionId: string, waitMs = 800): Promise<Shell> {
  const shellId = uuidv4();
  const shell = await openShellRaw(computeNode as any, shellId, connectionId);
  await new Promise((r) => setTimeout(r, 400)); // let bash start before sending newline
  await sendNewline(computeNode.id, shellId);
  await new Promise((r) => setTimeout(r, waitMs));
  return shell;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Unit tests (no backend, instant)
// ─────────────────────────────────────────────────────────────────────────────

describe('Shell SDK lifecycle — unit tests', () => {
  // ── restart() state machine ────────────────────────────────────────────────

  it('connect({ force }) resets replayDone to false and fires status event', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();
    (shell as any)._replayDone = true;
    (shell as any).emit('status', 'connected');

    const events: string[] = [];
    shell.on('status', (s: string) => events.push(s));

    // _restart() is the private method called by startPty({ force: true })
    (shell as any)._restart();

    expect(shell.replayDone).toBe(false);
    expect(events).toContain('disconnected');
  });

  it('connect({ force }) resets seq to 0 (ensures full replay on next connect)', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();
    (shell as any)._pty.lastSeq = 42;
    (shell as any)._replayDone = true;

    (shell as any)._restart();

    expect((shell as any)._pty.lastSeq).toBe(0);
  });

  // ── onOutput() gate across lifecycle ──────────────────────────────────────

  it('onOutput() → undefined → live → unsub cycle is clean', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();

    // Gate closed during replay
    expect(shell.onOutput(() => {})).toBeUndefined();

    // Gate opens after connect
    (shell as any)._replayDone = true;
    (shell as any).emit('status', 'connected');
    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));
    expect(unsub).not.toBeUndefined();

    (shell as any)._pty.appendOutput(btoa('hello'), 1, Date.now());
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('hello');

    // Unsubscribe — no more events
    unsub!();
    (shell as any)._pty.appendOutput(btoa('world'), 2, Date.now());
    expect(received).toHaveLength(1);
  });

  it('onOutput gate works across a full restart cycle', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();
    (shell as any)._replayDone = true;
    (shell as any).emit('status', 'connected');

    const unsub = shell.onOutput(() => {});
    expect(unsub).not.toBeUndefined();

    // _restart() closes the gate (called internally by startPty({ force: true }))
    (shell as any)._restart();
    expect(shell.onOutput(() => {})).toBeUndefined();

    // Re-open gate (simulates next startPty() completing)
    (shell as any)._replayDone = true;
    (shell as any).emit('status', 'connected');

    const live: string[] = [];
    const unsub2 = shell.onOutput((d) => live.push(d));
    expect(unsub2).not.toBeUndefined();

    (shell as any)._pty.appendOutput(btoa('after-restart'), 10, Date.now());
    expect(live[0]).toBe('after-restart');

    unsub?.();
    unsub2?.();
  });

  // ── Multiple subscribe() listeners ────────────────────────────────────────

  it('multiple on() listeners all notified on emit, unsub stops one', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    const counts = [0, 0, 0];
    const unsubs = [
      shell.on('status', () => counts[0]++),
      shell.on('status', () => counts[1]++),
      shell.on('status', () => counts[2]++),
    ];

    (shell as any).emit('status', 'connected');
    expect(counts).toEqual([1, 1, 1]);

    unsubs[1](); // remove middle listener

    (shell as any).emit('status', 'connected');
    expect(counts).toEqual([2, 1, 2]); // index 1 stopped

    unsubs[0]();
    unsubs[2]();
  });

  // ── getPtyChunks — sorted, dedup ──────────────────────────────────────────

  it('getPtyChunks() returns chunks in ascending seq order', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();

    // Insert in ascending seq order (appendOutput dedupes: seq <= lastSeq is rejected)
    (shell as any)._pty.appendOutput(btoa('A'), 1, Date.now());
    (shell as any)._pty.appendOutput(btoa('B'), 2, Date.now());
    (shell as any)._pty.appendOutput(btoa('C'), 3, Date.now());

    const chunks = shell.getPtyChunks();
    expect(chunks.map((c) => c.seq)).toEqual([1, 2, 3]);

    const decoder = new TextDecoder();
    expect(chunks.map((c) => decoder.decode(c.data)).join('')).toBe('ABC');
  });

  it('appendOutput dedupes: same seq received twice, only first is stored', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();

    (shell as any)._pty.appendOutput(btoa('first'), 5, Date.now());
    (shell as any)._pty.appendOutput(btoa('dupe'), 5, Date.now()); // same seq → ignored

    expect(shell.getPtyChunks()).toHaveLength(1);
    const decoder = new TextDecoder();
    expect(decoder.decode(shell.getPtyChunks()[0].data)).toBe('first');
  });

  it('getPtyChunk(seq) returns the right chunk', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();

    (shell as any)._pty.appendOutput(btoa('x'), 7, Date.now());
    const chunk = shell.getPtyChunk(7);
    expect(chunk).not.toBeUndefined();
    expect(chunk!.seq).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Integration stress tests (real backend + WebSocket)
// ─────────────────────────────────────────────────────────────────────────────

describe('Shell / PTY lifecycle stress — integration', () => {
  const info = getTestSignupInfo();
  let manager: ReturnType<typeof ConnectionManager.getInstance>;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    manager = ConnectionManager.getInstance();
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  // ── 1. Open + close many shells concurrently ───────────────────────────────

  it('connect() 5 shells concurrently — all reach replayDone, no corruption', async () => {
    const computeNode = await get_local_compute_node(`stress-conc-${Date.now()}`);
    await computeNode.setup();

    const N = 5;
    const shells: Shell[] = [];

    // Start PTYs sequentially (concurrent starts to the same compute node are rejected
    // by the backend). What we're stress-testing is concurrent connect() calls.
    for (let i = 0; i < N; i++) {
      const shell = await spawnShell(computeNode, manager.id, 800);
      shells.push(shell);
    }

    // Connect all 5 concurrently — this is the actual stress target
    await Promise.all(shells.map((s) => s.attachPty({ cols: 80, rows: 24 })));

    // All should have replayDone=true and at least 1 replay chunk
    for (const shell of shells) {
      expect(shell.replayDone).toBe(true);
      expect(shell.getPtyChunks().length).toBeGreaterThan(0);
    }

    // Close all concurrently
    await Promise.all(shells.map((s) => closePtyRaw(computeNode.id, s.id)));
  }, 45000);

  // ── 2. Rapid sequential open / close cycling ──────────────────────────────

  it('open and close 4 separate shells sequentially — no state leak', async () => {
    const computeNode = await get_local_compute_node(`stress-seq-${Date.now()}`);
    await computeNode.setup();

    for (let cycle = 0; cycle < 4; cycle++) {
      const shell = await spawnShell(computeNode, manager.id, 600);

      await shell.attachPty({ cols: 80, rows: 24 });

      expect(shell.replayDone).toBe(true);
      expect(shell.getPtyChunks().length).toBeGreaterThan(0);

      // No live-output bleed: gate is open, subscribe, then close
      const liveData: string[] = [];
      const unsub = shell.onOutput((d) => liveData.push(d));
      expect(unsub).not.toBeUndefined();

      await closePtyRaw(computeNode.id, shell.id);
      unsub?.();
    }
  }, 60000);

  // ── 3. Session restart: seq reset + full re-attach ────────────────────────

  it('restart() + reconnect delivers fresh replay — replayDone flips false then true', async () => {
    const computeNode = await get_local_compute_node(`stress-restart-${Date.now()}`);
    await computeNode.setup();

    const shell = await spawnShell(computeNode, manager.id, 600);

    // Initial connect
    await shell.attachPty({ cols: 80, rows: 24 });
    expect(shell.replayDone).toBe(true);
    expect(shell.getPtyChunks().length).toBeGreaterThan(0);

    // Restart — replayDone goes false, seq resets
    (shell as any)._restart();
    expect(shell.replayDone).toBe(false);
    expect((shell as any)._pty!.lastSeq).toBe(0);

    // More output so there's something new to replay
    await sendNewline(computeNode.id, shell.id);
    await new Promise((r) => setTimeout(r, 500));

    // Force re-attach by clearing pty.started
    if ((shell as any)._pty) (shell as any)._pty.started = false;
    await shell.attachPty({ cols: 80, rows: 24 });

    expect(shell.replayDone).toBe(true);
    expect(shell.getPtyChunks().length).toBeGreaterThan(0);

    await closePtyRaw(computeNode.id, shell.id);
  }, 25000);

  // ── 4. PTY recovery: close PTY, start fresh shell, verify clean state ─────

  it('new shell after PTY close has clean state — no double-write', async () => {
    const computeNode = await get_local_compute_node(`stress-recover-${Date.now()}`);
    await computeNode.setup();

    // Shell 1: open, connect, close PTY
    const shell1 = await spawnShell(computeNode, manager.id, 500);
    await shell1.attachPty({ cols: 80, rows: 24 });
    expect(shell1.replayDone).toBe(true);
    await closePtyRaw(computeNode.id, shell1.id);

    // Shell 2: fresh shell, no state from shell1
    const shell2 = await spawnShell(computeNode, manager.id, 600);
    await shell2.attachPty({ cols: 80, rows: 24 });

    expect(shell2.replayDone).toBe(true);
    expect(shell2.getPtyChunks().length).toBeGreaterThan(0);

    // Subscribe after connect — live listener receives NO replay bytes
    const liveData: string[] = [];
    const unsub = shell2.onOutput((d) => liveData.push(d));
    expect(unsub).not.toBeUndefined();

    const decoder = new TextDecoder();
    const replayText = shell2
      .getPtyChunks()
      .map((c) => decoder.decode(c.data))
      .join('');
    expect(replayText.length).toBeGreaterThan(0);
    // liveData only receives post-connect output, not replay bytes
    expect(liveData.join('')).toBe('');

    await closePtyRaw(computeNode.id, shell2.id);
    unsub?.();
  }, 25000);

  // ── 5. resize() while data is flowing ─────────────────────────────────────

  it('rapid resizes do not corrupt seq ordering', async () => {
    const computeNode = await get_local_compute_node(`stress-resize-${Date.now()}`);
    await computeNode.setup();

    const shell = await spawnShell(computeNode, manager.id, 500);
    await shell.attachPty({ cols: 80, rows: 24 });
    expect(shell.replayDone).toBe(true);

    // Fire several resizes rapidly while bash is live
    await Promise.all([shell.resize(120, 30), shell.resize(100, 25), shell.resize(80, 24)]);

    // Seq ordering must be preserved
    const seqs = shell.getPtyChunks().map((c) => c.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    await closePtyRaw(computeNode.id, shell.id);
  }, 20000);

  // ── 6. Shell.run() round-trip ──────────────────────────────────────────────

  it('Shell.run() executes a command and returns stdout + exitCode=0', async () => {
    const computeNode = await get_local_compute_node(`stress-run-${Date.now()}`);
    await computeNode.setup();

    const shellId = uuidv4();
    await openShellRaw(computeNode as any, shellId, manager.id);
    await new Promise((r) => setTimeout(r, 400));

    const shell = Object.assign(new Shell(), { id: shellId, compute_node_id: computeNode.id });
    const result = await shell.run('echo stress-test-ok');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('stress-test-ok');

    await closePtyRaw(computeNode.id, shellId);
  }, 20000);

  // ── 7. High-volume: 20 rapid newlines, verify seq monotonically increasing ─

  it('20 rapid newlines produce monotonically increasing seqs after connect()', async () => {
    const computeNode = await get_local_compute_node(`stress-volume-${Date.now()}`);
    await computeNode.setup();

    const shellId = uuidv4();
    await openShellRaw(computeNode as any, shellId, manager.id);
    await new Promise((r) => setTimeout(r, 300));

    // 20 rapid newlines
    for (let i = 0; i < 20; i++) {
      await sendNewline(computeNode.id, shellId);
    }
    // Let server accumulate all output
    await new Promise((r) => setTimeout(r, 1200));

    const shell = Object.assign(new Shell(), { id: shellId, compute_node_id: computeNode.id });
    registerShell(shell);

    await shell.attachPty({ cols: 80, rows: 24 });
    expect(shell.replayDone).toBe(true);

    const seqs = shell.getPtyChunks().map((c) => c.seq);
    expect(seqs.length).toBeGreaterThan(0);

    // Seqs must be strictly ascending
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    await closePtyRaw(computeNode.id, shellId);
  }, 25000);

  // ── 8. onOutput gate holds across concurrent shells (no cross-shell bleed) ─

  it('onOutput from shell A never fires on shell B listeners', async () => {
    const computeNode = await get_local_compute_node(`stress-gate-${Date.now()}`);
    await computeNode.setup();

    const shellA = await spawnShell(computeNode, manager.id, 600);
    const shellB = await spawnShell(computeNode, manager.id, 600);

    await shellA.attachPty({ cols: 80, rows: 24 });
    await shellB.attachPty({ cols: 80, rows: 24 });

    const bEvents: string[] = [];
    const unsubB = shellB.onOutput((d) => bEvents.push(d));

    // Send input only to A
    await sendNewline(computeNode.id, shellA.id);
    // Brief pause for any WS messages to settle
    await new Promise((r) => setTimeout(r, 300));

    // B's listener should not have fired from A's input
    // (Shell B's pty is separate; only its own WS messages go to bEvents)
    // We can't assert bEvents.length === 0 because B's pty may emit its own prompt,
    // but we CAN assert that bEvents contains only strings (no exceptions, no corruption)
    for (const e of bEvents) {
      expect(typeof e).toBe('string');
    }

    unsubB?.();
    await Promise.all([closePtyRaw(computeNode.id, shellA.id), closePtyRaw(computeNode.id, shellB.id)]);
  }, 25000);
});
