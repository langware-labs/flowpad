/**
 * AgenticProcess TypeScript SDK — frontend contract, against a live backend.
 *
 * Real entities via `apiTestSetup()` (a backend the runner launches via
 * `scripts/instance_ctl.sh` — never the user's). Covers the FE-side SDK
 * contracts that don't require a real vendor worker:
 *
 *   - `setVisible` — flips `visible` and round-trips through the backend, never
 *     touching `pty_mode` (README Rule 1: transport vs visibility are separate).
 *   - `appendUserMessage` / `getOutputs` — optimistic user-message ingest +
 *     dedup on the in-memory FlowData stream.
 *   - `getByWorkerId` — null contracts: `wf_*` short-circuits without a request;
 *     an unknown session id resolves to null (404), never throws.
 *
 * The live-worker methods (`wait` / `waitForComplete` / `waitForReady` /
 * `switchMode` / `upsertSessionProcess` adopt) need a real CLI turn or PTY and
 * are covered in the pytest api / long tiers — a JS-tier fake would need a real
 * `claude` binary, which the no-flaky / no-mask rules forbid substituting for.
 */
import { AgenticProcess, dataContext, WorkerStatus } from '@sdk';
import { describe, expect, it } from 'vitest';
import { apiTestSetup, trackCreatedRows } from '../utils/test-utils';
import { trackForCleanup } from '../_cleanup';

const { created, fetchRow } = trackCreatedRows(AgenticProcess.type);

async function makeHeadless(): Promise<AgenticProcess> {
  // No instruction ⇒ create + watch only (no worker launch): stays fast + driver-free.
  const { process } = await AgenticProcess.spawn(
    { workerType: 'claude_code', instructions: 'stay idle' },
    { headless: true },
  );
  created.push(process.id);
  trackForCleanup(process);
  return process;
}

describe('AgenticProcess.setVisible — flips visible only, never pty_mode', () => {
  it('shows then hides the tab; pty_mode stays false throughout', async () => {
    await apiTestSetup();
    const process = await makeHeadless();
    // headless spawn persists pty_mode=false (the A2 contract).
    expect((await fetchRow(process.id)).pty_mode).toBe(false);

    await process.setVisible(true);
    let row = await fetchRow(process.id);
    expect(row.visible).toBe(true);
    expect(row.pty_mode).toBe(false);

    await process.setVisible(false);
    row = await fetchRow(process.id);
    expect(row.visible).toBe(false);
    expect(row.pty_mode).toBe(false);
  });
});

describe('AgenticProcess.appendUserMessage / getOutputs', () => {
  it('ingests a user message once and dedups an identical re-append', async () => {
    await apiTestSetup();
    const process = await makeHeadless();

    const userMessages = () =>
      process.getOutputs().filter((fd) => (fd.attributes.role ?? '') === 'user' && fd.content === 'hello world');

    process.appendUserMessage('hello world');
    expect(userMessages()).toHaveLength(1);

    // Identical content ⇒ deduped (no duplicate USER_MESSAGE frame).
    process.appendUserMessage('hello world');
    expect(userMessages()).toHaveLength(1);

    // Empty / whitespace ⇒ no-op.
    const before = process.getOutputs().length;
    process.appendUserMessage('   ');
    expect(process.getOutputs().length).toBe(before);
  });
});

describe('AgenticProcess.getByWorkerId — null contracts', () => {
  it('short-circuits workflow-run ids to null (no backend request)', async () => {
    await apiTestSetup();
    expect(await AgenticProcess.getByWorkerId('wf_run-123')).toBeNull();
  });

  it('resolves an unknown session id to null (404), never throws', async () => {
    await apiTestSetup();
    expect(dataContext.computeNode).toBeTruthy();
    const missing = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
    expect(await AgenticProcess.getByWorkerId(missing, 'claude_code')).toBeNull();
  });
});

// Keep the WorkerStatus import meaningful — documents the terminal gate the
// deferred wait()/waitForComplete tests key on (see file header).
void WorkerStatus;
