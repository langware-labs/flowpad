/**
 * PTY Session WebSocket Notification Tests.
 *
 * Tests that when a PTY session is created via REST API, a WebSocket notification is sent to watchers.
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX, TypeId } from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

async function waitForConnection(manager: ConnectionManager) {
  await vi.waitFor(
    () => {
      if (!manager.connected) throw new Error('Cannot connect to ws server');
    },
    {
      timeout: 5000,
      interval: 500,
    },
  );
  expect(manager.connected).toBe(true);
}

describe('pty_test', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    // Create a local compute node for PTY tests
    computeNode = await get_local_compute_node('pty-test-node');
    // Setup the compute node provider (required for PTY sessions)
    await computeNode.setup();
  });

  it('test pty session websocket notification', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Watch the compute node for changes
    await computeNode.watch();

    // Track received DataOp messages
    let dataOpReceived = false;
    let receivedTypeId: TypeId | null = null;
    let receivedOp: string | null = null;
    let receivedData: any = null;

    manager.on('on_data_op', (toEntity: string, op: string, data: any) => {
      // on_data_op emits toEntity as a string (e.g. "compute_node-{uuid}")
      try {
        const parsedTypeId = new TypeId(toEntity);
        if (parsedTypeId.id === computeNode.id && parsedTypeId.type === 'compute_node') {
          dataOpReceived = true;
          receivedTypeId = parsedTypeId;
          receivedOp = op;
          receivedData = data;
        }
      } catch { /* ignore parse errors for other entity types */ }
    });

    // Create PTY session via REST API
    const sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const terminalUrl = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNode.id}/terminal-command/start`;

    const response = await apiClient.post(terminalUrl, {
      shell_id: sessionId,
      connection_id: manager.id,
      rows: 24,
      cols: 80,
    });

    // Verify REST API response (response is unwrapped to data object)
    expect(response).toBeTruthy();
    // The data object should contain message_type 'response_msg'
    expect((response as any).message_type).toBe('response_msg');

    // Wait for WebSocket notification
    await vi.waitFor(
      () => {
        if (!dataOpReceived) throw new Error('Did not receive DataOp notification');
      },
      {
        timeout: 5000,
        interval: 100,
      },
    );

    // Validate DataOp message
    expect(receivedTypeId).toBeTruthy();
    expect(receivedTypeId!.id).toBe(computeNode.id);
    expect(receivedTypeId!.type).toBe('compute_node');
    expect(receivedOp).toBe('update');
  }, 15000);

  it('test pty session notification contains session_id', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Watch the compute node for changes
    await computeNode.watch();

    // Track received DataOp messages.
    //
    // Collect ALL compute-node data-ops rather than keeping only the latest: this
    // backend emits a compute_node update for every PTY lifecycle event, including
    // ones belonging to other tests/sessions on the same instance. Latching onto
    // "the last notification seen" made the assertion depend on unrelated traffic —
    // an `active_pty_sessions: []` op from some other session's teardown would land
    // first, satisfy the wait, and fail the `toContain` check. In a full-suite run
    // that is exactly what happened; in isolation nothing else was talking, so it
    // passed. Wait for THIS session's notification instead.
    const receivedOps: any[] = [];

    manager.on('on_data_op', (toEntity: string, _op: string, data: any) => {
      // on_data_op emits toEntity as a string (e.g. "compute_node-{uuid}")
      try {
        const parsedTypeId = new TypeId(toEntity);
        if (parsedTypeId.id === computeNode.id && parsedTypeId.type === 'compute_node') {
          receivedOps.push(data);
        }
      } catch { /* ignore parse errors for other entity types */ }
    });

    // Create PTY session via REST API
    const sessionId = `claude-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const terminalUrl = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNode.id}/terminal-command/start`;

    const response = await apiClient.post(terminalUrl, {
      shell_id: sessionId,
      connection_id: manager.id,
      rows: 24,
      cols: 80,
    });

    expect(response).toBeTruthy();
    // The data object should contain message_type 'response_msg'
    expect((response as any).message_type).toBe('response_msg');

    // Wait for the WebSocket notification that carries THIS session (same 5s budget).
    let receivedData: any = null;
    await vi.waitFor(
      () => {
        receivedData = receivedOps.find((d) => d?.active_pty_sessions?.includes?.(sessionId)) ?? null;
        if (!receivedData) {
          throw new Error(
            `Did not receive a notification containing ${sessionId} ` +
              `(${receivedOps.length} compute_node op(s) seen)`,
          );
        }
      },
      {
        timeout: 5000,
        interval: 100,
      },
    );

    // Validate notification contains active_pty_sessions with our session_id
    expect(receivedData).toBeTruthy();
    expect(receivedData.active_pty_sessions).toBeDefined();
    expect(receivedData.active_pty_sessions).toContain(sessionId);

    // The compute node's frontend entity should be updated with the new session
    // Note: The DataOp updates the entity cache, so after the notification
    // the compute node should reflect the new active_pty_sessions
    await vi.waitFor(
      () => {
        // Refresh from cache after DataOp update
        if (!computeNode.active_pty_sessions?.includes(sessionId)) {
          throw new Error('ComputeNode frontend entity not updated with session');
        }
      },
      {
        timeout: 2000,
        interval: 100,
      },
    );
    expect(computeNode.active_pty_sessions).toContain(sessionId);
  }, 15000);
});
