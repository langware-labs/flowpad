/**
 * Regression: AgenticProcess.spawn() times out in shell.startPty()
 *
 * Root cause: _reattach() sends a WS rest_api_msg for terminal-command/attach.
 * The backend's _attach_pty_session() early-exits with ApiFailResponse("Invalid
 * request context") because request_info.request_message_id is None in the WS
 * execution context. The response has no response_message_id, so the pending
 * WS request is never resolved and times out.
 *
 * This test proves the failure end-to-end against a real server with no mocks.
 */

import { apiClient, ConnectionManager, dataManager, GRAPH_API_PREFIX, Shell, TypeId } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

describe('AgenticProcess.spawn() WS attach timeout regression', () => {
  const info = getTestSignupInfo();

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    await waitFor(() => ConnectionManager.getInstance().connected, 5000);
  });

  it('times out after 3s because _attach_pty_session returns no response_message_id', async () => {
    const computeNode = await get_local_compute_node();
    await computeNode.setup();
    const shellId = uuidv4();
    const cm = ConnectionManager.getInstance();

    // Start a real PTY on the server — this is the state after process.open()
    await apiClient.post(
      `${GRAPH_API_PREFIX}/compute_node/${computeNode.id}/terminal-command/start`,
      { shell_id: shellId, connection_id: cm.id, rows: 24, cols: 80 },
    );

    // Build the shell entity the same way spawn() does after open()
    const shell = Object.assign(new Shell(), { id: shellId, compute_node_id: computeNode.id });
    (dataManager as any).getRef(new TypeId('shell', shellId)).entity = shell;

    // This is the exact call that times out in the browser
    await expect(
      shell.startPty({ cols: 80, rows: 24, timeout: 3000 })
    ).rejects.toThrow('Request timeout');
  }, 15000);
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
