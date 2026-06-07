/**
 * PTY Output — attach gate + live chunk store (no server replay)
 *
 * Two test suites:
 *
 * Suite 1 (unit, no backend): proves shell.onOutput() gates on attached.
 *   - "direct subscription safe": direct ptyConnection.onOutput()
 *     subscription before attach does NOT receive chunks (gate in appendOutput)
 *   - "shell gate": shell.onOutput() returns undefined when not attached
 *   - "after attach": shell.onOutput() works normally once attached
 *   - "dedup": a chunk with a non-advancing seq is dropped
 *
 * Suite 2 (integration, backend required): end-to-end attach against a real
 *   PTY. The server sends no byte replay; the attach-time winsize jiggle makes
 *   the shell repaint, and those bytes land in the live chunk store (pty-sync
 *   source) even when they race the output subscription.
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
  it('direct ptyConnection.onOutput() subscription before attach does NOT receive chunks', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    // PtyConnection is always eagerly created — no manual setup needed.
    // _attached starts false, so appendOutput will NOT fire listeners.
    const received: string[] = [];
    const unsub = shell.ptyConnection.onOutput((d: string) => received.push(d));

    // Simulate a WS pty_output_msg arriving before attach completes.
    // appendOutput gates on _attached — no listeners fired yet.
    const b64 = btoa('bash$ ');
    shell.ptyConnection.appendOutput(b64, 1, Date.now());
    unsub();

    // Listener received nothing — chunk is buffered, not live-streamed.
    expect(received).toHaveLength(0);
    // Chunk IS stored in ptyConnection.chunks (pty-sync source).
    expect(shell.ptyConnection.getSortedChunks()).toHaveLength(1);
    const decoder = new TextDecoder();
    const chunkText = shell.ptyConnection.getSortedChunks()
      .map((c) => decoder.decode(c.data))
      .join('');
    expect(chunkText).toBe('bash$ ');
  });

  it('shell.onOutput() returns undefined when not attached — listener never registered', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    // Before attach() completes, attached is false.
    expect(shell.attached).toBe(false);

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));

    // Gate: onOutput() returns undefined — listener not registered.
    expect(unsub).toBeUndefined();

    // A WS chunk arriving before attach.
    const b64 = btoa('bash$ ');
    shell.ptyConnection.appendOutput(b64, 1, Date.now());

    // External listener received nothing — no double-write possible.
    expect(received).toHaveLength(0);

    // Chunk IS stored in ptyConnection.chunks (pty-sync source).
    expect(shell.getPtyChunks()).toHaveLength(1);
  });

  it('shell.onOutput() works normally after attach completes', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });

    // Simulate attach() completing: flip _attached on PtyConnection.
    (shell.ptyConnection as any)._attached = true;
    expect(shell.attached).toBe(true);

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));
    expect(unsub).not.toBeUndefined(); // subscribed successfully

    // A live output chunk arriving after attach.
    const b64 = btoa('$ ls\r\n');
    shell.ptyConnection.appendOutput(b64, 2, Date.now());
    unsub!();

    // Live listener received the chunk — normal behavior.
    expect(received.join('')).toBe('$ ls\r\n');
  });

  it('a chunk with a non-advancing seq is deduped', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell.ptyConnection as any)._attached = true;

    const received: string[] = [];
    const unsub = shell.onOutput((d) => received.push(d));

    const b64 = btoa('once');
    expect(shell.ptyConnection.appendOutput(b64, 5, Date.now())).toBe('once');
    // Same seq again — dropped before storing or notifying.
    expect(shell.ptyConnection.appendOutput(b64, 5, Date.now())).toBeNull();
    // Lower seq — also dropped.
    expect(shell.ptyConnection.appendOutput(b64, 4, Date.now())).toBeNull();
    unsub!();

    expect(received).toEqual(['once']);
    expect(shell.getPtyChunks()).toHaveLength(1);
  });

  it('onReady fires immediately if already attached', () => {
    const shell = new Shell({ id: uuidv4(), compute_node_id: uuidv4() });
    (shell.ptyConnection as any)._attached = true;

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
    (shell.ptyConnection as any)._attached = true;
    (shell.ptyConnection as any)._emitReady();

    expect(statuses).toContain('connected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Integration tests (real backend + WebSocket)
// ─────────────────────────────────────────────────────────────────────────────

describe('PTY attach — integration test with real PTY (no replay)', () => {
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

  it('attach repaints via winsize jiggle — bytes land in the chunk store; live I/O works', async () => {
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

    // Let the shell reach its prompt.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await sendPtyInputOverWS(computeNode.id, shellId, '\n');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const shell = new Shell({ id: shellId, compute_node_id: computeNode.id });
    const typeId = new TypeId('shell', shellId);
    const ref = (dataManager as any).getRef(typeId);
    ref.entity = shell;

    // Gate before attach: onOutput() returns undefined.
    expect(shell.onOutput(() => undefined)).toBeUndefined();

    // Attach without explicit size → server jiggles the winsize so the shell
    // repaints its prompt. No byte replay arrives.
    await shell.attachPty({});
    expect(shell.attached).toBe(true);

    // The repaint bytes may race the output subscription (they can arrive
    // before _attached flips), but they ALWAYS land in the chunk store —
    // that is what InteractiveTerminal writes into xterm on connect.
    await vi.waitFor(
      () => {
        if (shell.getPtyChunks().length === 0) throw new Error('no repaint chunk yet');
      },
      { timeout: 5000, interval: 100 },
    );
    const decoder = new TextDecoder();
    const repaintText = shell
      .getPtyChunks()
      .map((c) => decoder.decode(c.data))
      .join('');
    expect(repaintText.length).toBeGreaterThan(0);

    // Live I/O after attach: subscribed listener sees an echo round-trip.
    const liveData: string[] = [];
    const unsub = shell.onOutput((data) => liveData.push(data));
    expect(unsub).not.toBeUndefined();

    await sendPtyInputOverWS(computeNode.id, shellId, 'echo pty_live_check\n');
    await vi.waitFor(
      () => {
        if (!liveData.join('').includes('pty_live_check')) throw new Error('echo not yet received');
      },
      { timeout: 5000, interval: 100 },
    );
    unsub!();

    await apiClient
      .post(`${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/close`, {
        shell_id: shellId,
      })
      .catch(() => {});
  }, 15000);
});
