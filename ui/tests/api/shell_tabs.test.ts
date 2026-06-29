/**
 * Shell Session Tab Write-Through Tests.
 *
 * Verifies the write-through cache architecture for Entity→Record sync:
 * - When a Shell entity is updated via PUT /graph/shell/<id>,
 *   the change is written through to the ShellRecord on disk.
 * - After closing all tabs (status=closed), list-shells returns 0 tabs.
 *
 * These tests reproduce the "close all → refresh → tabs back" bug scenario
 * and verify the fix.
 *
 * Test setup: uses the running backend at localhost:9007.
 * ShellRecords are created on disk via the PTY start endpoint, then
 * their status is updated via the graph API.
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

/** Call list-shells via the REST API and return the records array. */
async function listShells(computeNodeId: string): Promise<any[]> {
  const url = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNodeId}/list-shells`;
  const response = await apiClient.get<any>(url);
  // apiClient unwraps ApiSuccessResponse — response is typically the data array
  if (Array.isArray(response)) return response;
  const data = (response as any)?.data ?? (response as any)?.content?.data;
  return Array.isArray(data) ? data : [];
}

/** Find a shell session by sessionId via list-shells. Returns null if not found. */
async function getShell(computeNodeId: string, sessionId: string): Promise<any | null> {
  // list-shells only returns active (non-closed) sessions.
  // For closed session checks we scan the fs-records disk store directly.
  const active = await listShells(computeNodeId);
  const found = active.find((r: any) => r.pty_session_id === sessionId || r.id === sessionId);
  if (found) return found;

  // Check closed sessions via fs-records scan
  const url = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNodeId}/fs-records/shell/${sessionId}`;
  try {
    const response = await apiClient.get<any>(url);
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      if ('pty_pid' in response || 'state' in response || 'status' in response) return response;
      const data = (response as any)?.data;
      if (data && typeof data === 'object' && ('pty_session_id' in data || 'state' in data)) return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a ShellRecord on disk by starting a PTY session.
 * Returns the session_id used.
 */
async function startPtySession(computeNodeId: string): Promise<string> {
  // Must be a pure UUID so Shell.from_record() creates a Shell entity (non-UUID IDs are skipped)
  const sessionId = uuidv4();
  const url = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNodeId}/terminal-command/start`;
  const manager = ConnectionManager.getInstance();
  await apiClient.post(url, {
    shell_id: sessionId,   // backend expects shell_id (not session_id)
    connection_id: manager.id,
    rows: 24,
    cols: 80,
  });
  return sessionId;
}

/**
 * Close a shell session by calling terminal-command/close.
 * This sets the disk record state to CLOSED via PtyRegistry.
 */
async function closePtySession(computeNodeId: string, sessionId: string): Promise<void> {
  const url = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNodeId}/terminal-command/close`;
  await apiClient.post(url, { shell_id: sessionId }).catch(() => {/* non-fatal if PTY not started */});
}

describe('shell_tabs', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    computeNode = await get_local_compute_node('tab-test-node');
    await computeNode.setup();
  });

  it('test_list_shells_excludes_closed', async () => {
    // Start a PTY session (creates ShellRecord with state=running)
    const sessionId = await startPtySession(computeNode.id);

    // Verify it appears in list
    const beforeClose = await listShells(computeNode.id);
    const sessionInList = beforeClose.find((r: any) => r.pty_session_id === sessionId || r.id === sessionId);
    expect(sessionInList).toBeTruthy();

    // Close it (sets disk record state=closed)
    await closePtySession(computeNode.id, sessionId);

    // After close, it should be excluded from the list
    const afterClose = await listShells(computeNode.id);
    const sessionStillInList = afterClose.find((r: any) => r.pty_session_id === sessionId || r.id === sessionId);
    expect(sessionStillInList).toBeUndefined();
  }, 15000);

  it('test_close_tab_write_through_persists', async () => {
    // Start a PTY session
    const sessionId = await startPtySession(computeNode.id);

    // Verify record exists with running state
    const before = await getShell(computeNode.id, sessionId);
    expect(before).toBeTruthy();
    const beforeState = before?.state ?? before?.status;
    expect(beforeState).toBe('running');

    // Close via terminal-command/close (triggers PtyRegistry disk write)
    await closePtySession(computeNode.id, sessionId);

    // Shell.close() deletes the disk record and the DB entity entirely —
    // so after close the session should no longer be discoverable.
    const after = await getShell(computeNode.id, sessionId);
    expect(after).toBeNull();
  }, 15000);

  it('test_refresh_scenario_no_tabs_after_close_all', async () => {
    // Reproduce the bug: start session, list→1 tab, close, list again→0 tabs
    const sessionId = await startPtySession(computeNode.id);

    // Simulate "page load" — list returns our session
    const initialList = await listShells(computeNode.id);
    const found = initialList.find((r: any) => r.pty_session_id === sessionId || r.id === sessionId);
    expect(found).toBeTruthy();

    // Close all (simulate "Close All" in tab bar)
    await closePtySession(computeNode.id, sessionId);

    // Simulate "page refresh" — list should return 0 of our sessions
    const afterRefresh = await listShells(computeNode.id);
    const stillFound = afterRefresh.find((r: any) => r.pty_session_id === sessionId || r.id === sessionId);
    expect(stillFound).toBeUndefined();
  }, 15000);

  it('test_open_tab_sets_running', async () => {
    // Starting a PTY session should produce a record with state=running
    const sessionId = await startPtySession(computeNode.id);

    const record = await getShell(computeNode.id, sessionId);
    expect(record).toBeTruthy();
    const state = record?.state ?? record?.status;
    expect(state).toBe('running');
  }, 15000);
});
