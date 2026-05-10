/**
 * PTY Output Corruption — connect() Race Condition Fix
 *
 * Two test suites:
 *
 * Suite 1 (unit, no backend): proves shell.onOutput() gates on replayDone.
 *   - "direct subscription safe": shows that direct ptyConnection.onOutput()
 *     subscription during replay does NOT receive chunks (gate in appendOutput)
 *   - "shell gate": shell.onOutput() returns undefined when replayDone is false
 *   - "after ready": shell.onOutput() works normally after replay completes
 *
 * Suite 2 (integration, backend required): end-to-end round-trip using real
 *   PTY replay. Confirms liveText === '' after connect() with real WS data.
 */

import { ActionInfo, apiClient, ConnectionManager, dataManager, GRAPH_API_PREFIX, Shell, TypeId } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

async function sendPtyInputOverWS(computeNodeId: string, shellId: string, data: string): Promise<void> {
  const action = new ActionInfo('terminal-command', 'compute_node', computeNodeId, 'POST');
  action.subpath = 'input';
  action.bodyParameters = { shell_id: shellId, data };
  await dataManager.callActionOverWS(action);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Unit tests (no backend, instant)
// ─────────────────────────────────────────────────────────────────────────────

describe('PTY onOutput() gate — unit tests', () => {
  it('direct ptyConnection.onOutput() subscription during replay does NOT receive chunks', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    // PtyConnection is always eagerly created — no manual setup needed.
    // _replayDone starts false, so appendOutput will NOT fire listeners.
    const received: string[] = [];
    const unsub = shell.ptyConnection.onOutput((d: string) => received.push(d));

    // Simulate a WS pty_output_msg arriving during reattach (server replay).
    // appendOutput gates on _replayDone — no listeners fired yet.
    const b64 = btoa('bash$ ');
    shell.ptyConnection.appendOutput(b64, 1, Date.now());
    unsub();

    // Listener received nothing — chunk is buffered for replay, not live-streamed.
    expect(received).toHaveLength(0);
    // Chunk IS stored in ptyConnection.chunks for the replay write.
    expect(shell.ptyConnection.getSortedChunks()).toHaveLength(1);
    const decoder = new TextDecoder();
    const chunkText = shell.ptyConnection.getSortedChunks()
      .map((c) => decoder.decode(c.data))
      .join('');
    expect(chunkText).toBe('bash$ ');
  });

  it('shell.onOutput() returns undefined when replayDone is false — listener never registered', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    // Before attach() completes, replayDone is false.
    expect(shell.replayDone).toBe(false);

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));

    // Gate: onOutput() returns undefined — listener not registered.
    expect(unsub).toBeUndefined();

    // A WS chunk arriving during reattach.
    const b64 = btoa('bash$ ');
    shell.ptyConnection.appendOutput(b64, 1, Date.now());

    // External listener received nothing — no double-write possible.
    expect(received).toHaveLength(0);

    // Chunk IS stored in ptyConnection.chunks for the replay write.
    expect(shell.getPtyChunks()).toHaveLength(1);
  });

  it('shell.onOutput() works normally after replayDone flips true', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    // Simulate attach() completing: flip _replayDone on PtyConnection.
    (shell.ptyConnection as any)._replayDone = true;
    expect(shell.replayDone).toBe(true);

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));
    expect(unsub).not.toBeUndefined(); // subscribed successfully

    // A live output chunk arriving after replay is done.
    const b64 = btoa('$ ls\r\n');
    shell.ptyConnection.appendOutput(b64, 2, Date.now());
    unsub!();

    // Live listener received the chunk — normal behavior.
    expect(received.join('')).toBe('$ ls\r\n');
  });

  it('onReady fires immediately if replay is already done', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell.ptyConnection as any)._replayDone = true;

    const fired: boolean[] = [];
    const unsub = shell.ptyConnection.onReady(() => fired.push(true));
    expect(fired).toHaveLength(1); // fired immediately
    unsub();
  });

  it('shell status bridge: ptyConnection.onReady fires shell status=connected event', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    const statuses: string[] = [];
    shell.on('status', (s: string) => statuses.push(s));

    // Simulate attach() completing
    (shell.ptyConnection as any)._replayDone = true;
    (shell.ptyConnection as any)._emitReady();

    expect(statuses).toContain('connected');
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
      () => {
        if (!manager.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  it('FIX: liveText === "" after connect() with real PTY replay — no double-write', async () => {
    const computeNode = await get_local_compute_node(`pty-fix-${Date.now()}`);
    await computeNode.setup();

    const shellId = uuidv4();
    const manager = ConnectionManager.getInstance();

    await apiClient.post(`${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/start`, {
      shell_id: shellId,
      connection_id: manager.id,
      rows: 24,
      cols: 80,
    });

    // Let bash start, then send a newline to guarantee it emits a prompt
    await new Promise((resolve) => setTimeout(resolve, 400));
    await sendPtyInputOverWS(computeNode.id, shellId, '\n');

    // Wait for the echo + prompt to be stored with seq numbers on the server
    await new Promise((resolve) => setTimeout(resolve, 800));

    const shell = new Shell({ id: shellId, compute_node_id: computeNode.id });
    const typeId = new TypeId('shell', shellId);
    const ref = (dataManager as any).getRef(typeId);
    ref.entity = shell;

    const liveData: string[] = [];

    // Fire connect — reattach() yields asynchronously
    const connectPromise = shell.attachPty({ cols: 80, rows: 24 });

    // Attempt to subscribe during the race window.
    // replayDone is false → onOutput() returns undefined → NOT subscribed.
    const unsub = shell.onOutput((data) => liveData.push(data));
    expect(unsub).toBeUndefined(); // gate confirmed

    await connectPromise;
    unsub?.();

    const decoder = new TextDecoder();
    const replayText = shell
      .getPtyChunks()
      .map((c) => decoder.decode(c.data))
      .join('');
    const liveText = liveData.join('');

    expect(replayText.length).toBeGreaterThan(0); // replay chunks stored in SDK
    expect(liveText).toBe(''); // external listener got nothing

    await apiClient
      .post(`${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/close`, {
        shell_id: shellId,
      })
      .catch(() => {});
  }, 15000);
});
