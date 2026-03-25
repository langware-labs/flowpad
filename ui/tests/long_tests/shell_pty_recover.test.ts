/**
 * Shell PTY Recovery Tests — Vitest mirror of tests/long_tests/test_shell_pty_recover.py
 *
 * Uses the same SDK primitives the frontend uses:
 *   - apiClient.post/get for HTTP actions (create shell, start PTY, send input)
 *   - ConnectionManager.sendRestApiMessage() for WS-only actions (terminal-command/attach)
 *   - ConnectionManager.on('on_pty_output_msg') to receive PTY output over WebSocket
 *
 * Scenarios:
 * A. Reattach — start a PTY via WS1 (manager.id), echo "reattach_hello".
 *    Then call terminal-command/attach → response content.status === "reattached".
 *    Send new input, verify PTY is live and output arrives.
 *
 * B. Not-found + fresh open — call terminal-command/attach on a shell with no
 *    PTY session → content.status === "not_found".
 *    Then start a fresh PTY, verify echo works.
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PtyOutputMsg {
  message_type: 'pty_output_msg';
  shell_id: string;
  data: string; // base64-encoded
  seq?: number;
}

interface AttachContent {
  status: 'reattached' | 'not_found';
  latest_seq?: number;
  shell_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode base64 PTY data to UTF-8 string. */
function decodePtyData(base64: string): string {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Register a PTY output listener for `shellId`, resolve when `keyword` appears.
 * Returns a Promise<string> for the full accumulated text.
 */
function waitForPtyKeyword(
  manager: ConnectionManager,
  shellId: string,
  keyword: string,
  timeoutMs = 15000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    const timer = setTimeout(() => {
      manager.off('on_pty_output_msg', handler);
      reject(new Error(`Timeout waiting for "${keyword}" in PTY output. Got: ${accumulated.slice(-300)}`));
    }, timeoutMs);

    const handler = (msg: PtyOutputMsg) => {
      if (msg.shell_id !== shellId) return;
      accumulated += decodePtyData(msg.data);
      if (accumulated.includes(keyword)) {
        clearTimeout(timer);
        manager.off('on_pty_output_msg', handler);
        resolve(accumulated);
      }
    };

    manager.on('on_pty_output_msg', handler);
  });
}

/**
 * Start PTY for a shell via terminal-command/start (HTTP).
 * Requires connection_id so the server routes PTY output to our WS.
 */
async function startPty(cnId: string, shellId: string, manager: ConnectionManager): Promise<void> {
  const url = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${cnId}/terminal-command/start`;
  await apiClient.post(url, {
    shell_id: shellId,
    connection_id: manager.id,
    rows: 24,
    cols: 80,
  });
}

/**
 * Send keyboard input to a running PTY via terminal-command/input over WS.
 * Must use WS because the backend requires request_message_id + request_connection_id
 * from WS context (HTTP calls return "Invalid request context").
 */
async function sendPtyInput(
  manager: ConnectionManager,
  cnId: string,
  shellId: string,
  data: string,
): Promise<void> {
  await manager.sendRestApiMessage({
    message_type: 'rest_api_msg',
    message_id: uuidv4(),
    method: 'POST',
    scope: [],
    direct_resource_type: null,
    target_typeid: { type: 'compute_node', id: cnId },
    action: 'terminal-command',
    sub_path: 'input',
    query_params: null,
    body: { shell_id: shellId, data },
  });
}

/**
 * Call terminal-command/attach over WebSocket.
 * The backend requires WS context (request_connection_id + request_message_id).
 * Returns the response content: {status: "reattached"|"not_found", latest_seq?, ...}
 */
async function attachPtyViaWs(
  manager: ConnectionManager,
  cnId: string,
  shellId: string,
  sinceSeq = 0,
): Promise<AttachContent> {
  const content = await manager.sendRestApiMessage<AttachContent>({
    message_type: 'rest_api_msg',
    message_id: uuidv4(),
    method: 'POST',
    scope: [],
    direct_resource_type: null,
    target_typeid: { type: 'compute_node', id: cnId },
    action: 'terminal-command',
    sub_path: 'attach',
    query_params: null,
    body: { shell_id: shellId, since_seq: sinceSeq },
  });
  return content;
}

/** Create a shell entity via HTTP, return its id. */
async function createShell(cnId: string, name: string): Promise<string> {
  const data = await apiClient.post<any>(`${GRAPH_API_PREFIX}/shell`, {
    name,
    compute_node_id: cnId,
  });
  return (data as any).id as string;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('shell_pty_recover', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;
  let manager: ConnectionManager;

  beforeEach(async (context: any) => {
    // Fail fast with a clear message if the server is not running
    try {
      await fetch('http://localhost:9007/health/status', { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new Error(
        'Server not running at localhost:9007 — start it with: uv run -m flow_sdk.server.run',
      );
    }

    await apiTestSetup(info, context.task.name);
    computeNode = await get_local_compute_node('pty-recover-node');
    await computeNode.setup();
    manager = ConnectionManager.getInstance();
    // Ensure WS is connected
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  // ── A: Reattach ─────────────────────────────────────────────────────────────

  it('A: reattach — starts PTY, echoes, reattaches on same WS, gets "reattached" + live I/O', async () => {
    const shellId = await createShell(computeNode.id, 'reattach-test');

    // Start PTY — server routes output to manager.id (our WS connection)
    await startPty(computeNode.id, shellId, manager);

    // Echo a unique marker
    const marker = `reattach_hello_${Date.now()}`;
    const echoPromise = waitForPtyKeyword(manager, shellId, marker);
    await sendPtyInput(manager, computeNode.id, shellId, `echo ${marker}\n`);
    const echoOutput = await echoPromise;
    expect(echoOutput).toContain(marker);

    // Reattach via WS (simulating browser refresh / reconnect)
    const attachResult = await attachPtyViaWs(manager, computeNode.id, shellId, 0);
    expect(attachResult).toBeTruthy();
    expect(attachResult.status).toBe('reattached');

    // After reattach the PTY session is live — send new input and verify output
    const marker2 = `after_reattach_${Date.now()}`;
    const livePromise = waitForPtyKeyword(manager, shellId, marker2);
    await sendPtyInput(manager, computeNode.id, shellId, `echo ${marker2}\n`);
    const liveOutput = await livePromise;
    expect(liveOutput).toContain(marker2);
  }, 30000);

  // ── B: Not-found + fresh open ────────────────────────────────────────────────

  it('B: not_found — attach to idle shell returns "not_found"; open fresh PTY works', async () => {
    // Create shell but never start its PTY
    const shellId = await createShell(computeNode.id, 'no-pty-shell');

    // Attach to shell with no active PTY session
    const attachResult = await attachPtyViaWs(manager, computeNode.id, shellId, 0);
    expect(attachResult).toBeTruthy();
    expect(attachResult.status).toBe('not_found');

    // Open a fresh PTY — server starts a new session
    await startPty(computeNode.id, shellId, manager);

    // Verify PTY is live
    const marker = `fresh_start_${Date.now()}`;
    const outputPromise = waitForPtyKeyword(manager, shellId, marker);
    await sendPtyInput(manager, computeNode.id, shellId, `echo ${marker}\n`);
    const output = await outputPromise;
    expect(output).toContain(marker);
  }, 30000);
});
