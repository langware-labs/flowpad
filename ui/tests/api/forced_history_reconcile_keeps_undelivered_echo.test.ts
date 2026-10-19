/**
 * A forced history reconcile must not erase a prompt the transcript has not
 * recorded yet — against a live backend.
 *
 * The chat pane draws the user's own message from `appendUserMessage`, a
 * client-only placeholder: the backend deliberately drops the transcript's
 * USER_MESSAGE row from the live stream (agentic_process.py:4258, "the client
 * echoes the user turn optimistically"). So between SUBMIT and the moment the
 * vendor writes the user row, that placeholder is the ONLY copy anywhere.
 *
 * `loadHistory({ force: true })` — what a remounted pane runs
 * (useTurnCompletionReconcile) — clears the stream and re-appends the
 * transcript. Inside that window the transcript carries no such row, so a
 * content-paired retract has nothing to pair and the clear takes the message
 * with it: the answer later streams in with no question above it.
 *
 * Real backend, real `get-history`, real dataManager, real FlowDataStream —
 * nothing stubbed. The state under test (echo present, transcript silent) is
 * created the way the product creates it: the pane's own submit-time call.
 */
import { AgenticProcess, FlowElementTypes } from '@sdk';
import { describe, expect, it } from 'vitest';
import { apiTestSetup, trackCreatedRows } from '../utils/test-utils';
import { trackForCleanup } from '../_cleanup';

const { created } = trackCreatedRows(AgenticProcess.type);

const PROMPT = 'what is a shadow folder?';

async function makeHeadless(): Promise<AgenticProcess> {
  const { process } = await AgenticProcess.spawn(
    { workerType: 'claude_code', instructions: 'stay idle' },
    { headless: true },
  );
  created.push(process.id);
  trackForCleanup(process);
  return process;
}

function userMessages(process: AgenticProcess) {
  return process
    .getOutputs()
    .filter((item) => item.elementType === FlowElementTypes.USER_MESSAGE || item.attributes?.role === 'user');
}

describe('forced history reconcile vs. an undelivered prompt', () => {
  it('keeps the prompt the user just submitted when the transcript has no row for it', async () => {
    await apiTestSetup();
    const process = await makeHeadless();

    // Baseline: whatever the real transcript holds for a fresh process.
    await process.loadHistory();
    const before = userMessages(process).length;

    // SUBMIT — the pane's own optimistic echo. Nothing has reached the vendor
    // yet, so no transcript row exists for it (the real pre-delivery window).
    process.appendUserMessage(PROMPT);
    expect(userMessages(process)).toHaveLength(before + 1);

    // The reconcile a remounted pane performs.
    await process.loadHistory({ force: true });

    expect(userMessages(process).map((m) => m.content)).toContain(PROMPT);
  });
});
