/**
 * Regression test: AgenticProcess.fromClaudeSession → open() must use --resume.
 *
 * Bug: fromClaudeSession() created a process without cli_config.resume=true.
 * open() then ran `--session-id <uuid>` on an existing session, causing:
 *   "Error: Invalid session ID. Must be a valid UUID."
 *
 * Requires a running backend (localhost:9007) with at least one indexed claude_session.
 */

import { AgenticProcess, ClaudeCliOptions, GRAPH_API_PREFIX, ComputeNode, apiClient, dataContext, dataManager } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const API = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local`;

/** Fetch one claude_session record ID from FTS index (fast). */
async function findAnyCloudeSessionId(): Promise<string | null> {
  // Backend search parameter is record_type (not type)
  const resp = await apiClient.get<any>(`${API}/fs-records/search?q=claude&record_type=claude_session&limit=1`);
  const results: any[] = resp?.data?.results ?? resp?.results ?? [];
  // Verify we got a real claude_session record (not some other type)
  const sessionRecord = results.find((r: any) => r.record_type === 'claude_session');
  return sessionRecord?.record_id ?? null;
}

describe('AgenticProcess.fromClaudeSession', () => {
  beforeEach(async (context: any) => {
    await apiTestSetup(getTestSignupInfo(), context.task.name);
  });

  it('sets cli_config.resume=true on the returned process', async () => {
    const sessionId = await findAnyCloudeSessionId();
    if (!sessionId) {
      console.warn('[SKIP] No claude_session records found — run Claude once first');
      return;
    }

    let proc;
    try {
      proc = await AgenticProcess.fromClaudeSession(sessionId);
    } catch (e: any) {
      if (e.message?.includes('Cannot resolve workdir')) {
        console.warn('[SKIP] Session found but has no workdir — record may be incomplete');
        return;
      }
      throw e;
    }
    expect(proc.session_id).toBe(sessionId);
    expect((proc as any).cli_config?.resume).toBe(true);
  }, 15000);

  it('open() does not produce "Invalid session ID" error in PTY', async () => {
    const sessionId = await findAnyCloudeSessionId();
    if (!sessionId) {
      console.warn('[SKIP] No claude_session records found — run Claude once first');
      return;
    }

    let proc;
    try {
      proc = await AgenticProcess.fromClaudeSession(sessionId);
    } catch (e: any) {
      if (e.message?.includes('Cannot resolve workdir')) {
        console.warn('[SKIP] Session found but has no workdir — record may be incomplete');
        return;
      }
      throw e;
    }
    await proc.start();

    const shell = await proc.shell();
    expect(shell).not.toBeNull();

    // Wait for PTY to produce output
    await new Promise(r => setTimeout(r, 3000));

    const output = shell!.getPtyChunks()
      .map(c => new TextDecoder().decode(c.data))
      .join('');

    console.log('[PTY output]', output);
    expect(output).not.toContain('Invalid session ID');
    expect(output).not.toContain('Session ID is already in use');

    await proc.stop();
  }, 30000);

  it('cli_config flag persists after save() and re-fetch', async () => {
    const sessionId = await findAnyCloudeSessionId();
    if (!sessionId) {
      console.warn('[SKIP] No claude_session records found — run Claude once first');
      return;
    }

    let proc;
    try {
      proc = await AgenticProcess.fromClaudeSession(sessionId);
    } catch (e: any) {
      if (e.message?.includes('Cannot resolve workdir')) {
        console.warn('[SKIP] Session found but has no workdir — record may be incomplete');
        return;
      }
      throw e;
    }

    // Deserialize server's cli_config via cliOptions getter
    const cliOptions = proc.cliOptions as ClaudeCliOptions;
    expect(cliOptions.resume).toBe(true);  // set by fromClaudeSession

    // Override a flag and save back to server
    cliOptions.debug = false;
    proc.cli_config = cliOptions.toJson();
    await proc.save();

    // Re-fetch from server — verify flag persisted
    const proc2 = await AgenticProcess.getById(proc.id!);
    expect(proc2).not.toBeNull();

    const cliOptions2 = proc2!.cliOptions as ClaudeCliOptions;
    expect(cliOptions2.debug).toBe(false);           // override survived round-trip
    expect(cliOptions2.resume).toBe(true);            // original intent preserved
    expect(cliOptions2.toShellString()).not.toContain('--debug');
    expect(cliOptions2.toShellString()).toContain('--resume');
  }, 15000);
});
