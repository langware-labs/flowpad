/**
 * PTY Output Corruption — connect() Race Condition Fix
 *
 * Two test suites:
 *
 * Suite 1 (unit, no backend): proves shell.onOutput() gates on replayDone.
 *   - "failing scenario": shows the bug mechanism — direct pty.onOutput()
 *     subscription during replay receives chunks → double-write would occur
 *   - "fix": shell.onOutput() returns undefined when replayDone is false
 *     → the external listener is never registered → no double-write
 *
 * Suite 2 (integration, backend required): end-to-end round-trip using real
 *   PTY replay. Confirms liveText === '' after connect() with real WS data.
 */

import { apiClient, ConnectionManager, dataManager, GRAPH_API_PREFIX, Shell, TypeId } from '@sdk';
import { PtyConnection } from '@sdk/services/shell/ptyConnection';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Unit tests (no backend, instant)
// ─────────────────────────────────────────────────────────────────────────────

describe('PTY onOutput() gate — unit tests', () => {
  it('FAILING SCENARIO: direct pty.onOutput() subscription during replay receives chunks (bug mechanism)', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    // Simulate connect() creating pty before reattach
    (shell as any)._pty = new PtyConnection();

    // An external listener that bypasses the SDK gate by subscribing directly
    const received: string[] = [];
    const unsub = (shell as any)._pty.onOutput((d: string) => received.push(d));

    // Simulate a WS pty_output_msg arriving during reattach (server replay)
    const b64 = btoa('bash$ ');
    (shell as any)._pty.appendOutput(b64, 1, Date.now());
    unsub();

    // Direct subscriber received the replay chunk — this is the bug:
    // if InteractiveTerminal's output handler subscribed like this during reattach,
    // it would write the same chunk twice (once via listener, once via getPtyChunks).
    expect(received.join('')).toBe('bash$ ');
    // Same chunk is also in getPtyChunks → caller would write it AGAIN
    const decoder = new TextDecoder();
    const chunkText = shell.getPtyChunks().map((c) => decoder.decode(c.data)).join('');
    expect(chunkText).toBe('bash$ ');
    expect(received.join('')).toBe(chunkText); // identical → double-write
  });

  it('FIX: shell.onOutput() returns undefined when replayDone is false — listener never registered', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();

    // Before connect() completes, replayDone is false
    expect(shell.getSnapshot().replayDone).toBe(false);

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));

    // Gate: onOutput() returns undefined — listener not registered
    expect(unsub).toBeUndefined();

    // A WS chunk arriving during reattach
    const b64 = btoa('bash$ ');
    (shell as any)._pty.appendOutput(b64, 1, Date.now());

    // External listener received nothing — no double-write possible
    expect(received).toHaveLength(0);

    // Chunk IS stored in pty.chunks for the replay write
    expect(shell.getPtyChunks()).toHaveLength(1);
  });

  it('FIX: shell.onOutput() works normally after replayDone flips true', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell as any)._pty = new PtyConnection();

    // Simulate connect() completing
    (shell as any)._bump({ connected: true, replayDone: true, status: 'live' });
    expect(shell.getSnapshot().replayDone).toBe(true);

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));
    expect(unsub).not.toBeUndefined(); // subscribed successfully

    // A live output chunk arriving after replay is done
    const b64 = btoa('$ ls\r\n');
    (shell as any)._pty.appendOutput(b64, 2, Date.now());
    unsub!();

    // Live listener received the chunk — normal behavior
    expect(received.join('')).toBe('$ ls\r\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Integration tests (real backend + WebSocket)
// ─────────────────────────────────────────────────────────────────────────────

describe('PTY output corruption — integration test with real PTY', () => {
  const info = getTestSignupInfo();

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    const manager = ConnectionManager.getInstance();
    await vi.waitFor(
      () => { if (!manager.connected) throw new Error('WS not connected'); },
      { timeout: 5000, interval: 200 },
    );
  });

  it('FIX: liveText === "" after connect() with real PTY replay — no double-write', async () => {
    const computeNode = await get_local_compute_node(`pty-fix-${Date.now()}`);
    await computeNode.setup();

    const shellId = uuidv4();
    const manager = ConnectionManager.getInstance();

    await apiClient.post(
      `${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/start`,
      { shell_id: shellId, connection_id: manager.id, rows: 24, cols: 80 },
    );

    // Let bash start, then send a newline to guarantee it emits a prompt
    await new Promise((resolve) => setTimeout(resolve, 400));
    await apiClient.post(
      `${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/input`,
      { shell_id: shellId, data: '\n' },
    ).catch(() => {});

    // Wait for the echo + prompt to be stored with seq numbers on the server
    await new Promise((resolve) => setTimeout(resolve, 800));

    const shell = Object.assign(new Shell(), { id: shellId, compute_node_id: computeNode.id });
    const typeId = new TypeId('shell', shellId);
    const ref = (dataManager as any).getRef(typeId);
    ref.entity = shell;

    const liveData: string[] = [];

    // Fire connect — pty is created synchronously, then reattach() yields
    const connectPromise = shell.connect({ cols: 80, rows: 24 });

    // Attempt to subscribe during the race window.
    // replayDone is false → onOutput() returns undefined → NOT subscribed.
    const unsub = shell.onOutput((data) => liveData.push(data));
    expect(unsub).toBeUndefined(); // gate confirmed

    await connectPromise;
    unsub?.();

    const decoder = new TextDecoder();
    const replayText = shell.getPtyChunks().map((c) => decoder.decode(c.data)).join('');
    const liveText = liveData.join('');

    expect(replayText.length).toBeGreaterThan(0); // replay chunks stored in SDK
    expect(liveText).toBe('');                    // external listener got nothing

    await apiClient
      .post(`${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/close`, {
        shell_id: shellId,
      })
      .catch(() => {});
  }, 15000);
});
