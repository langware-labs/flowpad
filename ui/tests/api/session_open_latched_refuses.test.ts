/**
 * RCA + fix pinning (api tier, real backend) for the 9007 symptom
 * "I can't open a session".
 *
 * The backend `_perform_open` latch gate distinguishes intent by the `retry`
 * flag: retry=false = automatic/speculative open (recovery watchdog) → refused
 * while a process is latched (the spawn→die→respawn loop breaker); retry=true =
 * explicit human action → clears the latch and relaunches. The bug was that the
 * UI's own "open a session" mount sent retry=false, so a user's deliberate open
 * was refused like a machine poll. Fix B: the interactive mount now sends
 * retry:true (TabbedTerminal.tsx). This test pins both halves of that contract.
 *
 * Steps:
 *   1. create the standard (interactive PTY) process — created, not launched
 *   2. mimic the locked situation — latch start_failure with the instant-exit
 *      message the codex writer-lock produced (real field, real persistence;
 *      the open path under test is NOT mocked)
 *   3a. FAIL PART — an automatic open (retry=false) is still refused with the
 *       exact "Auto-relaunch is paused" message (loop breaker intact)
 *   3b. RETRY → PASS — a user open (retry=true, what the mount now sends)
 *       clears the latch and is admitted: start() resolves and start_failure
 *       is cleared on the persisted row.
 *
 * Real entity + real backend (apiTestSetup). A shell-mode terminal is used so
 * the retry launch is a plain PTY shell (no vendor CLI / auth), fast and
 * reliable, and it is reaped before the row is cleaned up.
 */
import { AgenticProcess, ComputeNode } from '@sdk';
import { describe, expect, it } from 'vitest';
import { apiTestSetup, trackCreatedRows } from '../utils/test-utils';

const { created, fetchRow } = trackCreatedRows(AgenticProcess.type);

const LATCH = 'Worker exited 0.5s after launch (exit code 1).';
const PAUSED = 'Auto-relaunch is paused — use Retry to relaunch.';

function errText(err: any): string {
  return (
    err?.response?.data?.message ??
    err?.message ??
    String(err)
  );
}

describe('open a latched session: automatic open refused, user retry opens', () => {
  it('retry=false stays refused (loop breaker); retry=true clears the latch and opens', async () => {
    await apiTestSetup();

    // 1. Standard interactive terminal process, created but not launched.
    const cn = await ComputeNode.getLocal();
    expect(cn).toBeTruthy();
    const process = await cn!.createProcess(
      { shellMode: true },
      { visible: false, pty_mode: true, watchProcess: false },
    );
    created.push(process.id);
    expect(process.pty_mode).not.toBe(false);

    // 2. Mimic the locked situation: latch the instant-exit start_failure.
    process.start_failure = LATCH;
    await process.save();

    // 3a. FAIL PART — an automatic (retry=false) open is refused with the exact
    //     latch message. This is the path the UI used to send.
    let refused = '';
    try {
      await process.start({ visible: true, retry: false });
      throw new Error('BUG: a latched process must refuse an automatic (retry=false) open');
    } catch (err) {
      refused = errText(err);
    }
    expect(refused).toContain(PAUSED);

    // The latch is still in place after the refusal.
    expect((await fetchRow(process.id)).start_failure).toBe(LATCH);

    // 3b. RETRY → PASS — a user open (retry=true, what TabbedTerminal now sends)
    //     clears the latch and is admitted.
    try {
      const ok = await process.start({ visible: true, retry: true });
      expect(ok).toBe(true);
    } finally {
      // Reap the worker so the launched PTY does not outlive the test.
      await process.exit().catch(() => {});
    }

    // The persisted latch is gone — the session is openable again.
    expect((await fetchRow(process.id)).start_failure ?? null).toBeNull();
  });
});
