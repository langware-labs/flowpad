/**
 * FLOWPAD-1981 — the position an observing client states must ADVANCE.
 *
 * `observeTurn` tells the backend the last transcript entry it holds, and the
 * stream resumes after it. That only works if the client can see an entry id
 * on what it receives. `process_entry` rides the history payload (JSON) but
 * NOT the live wire: `FlowData.to_xml` serializes attributes and content only.
 * So every `observe-turn` frame used to arrive anonymous, `lastHeldTranscriptEntryId`
 * could only ever return the last id HISTORY delivered, and each re-open
 * re-stated that frozen position — replaying the whole turn the pane had
 * already rendered.
 *
 * The fix is the `transcript-entry-id` ATTRIBUTE (stamped by
 * `claude/session_history.py:_stamp_entry_id`, the convention codex already
 * used), which does survive `to_xml`.
 *
 * The wire bytes below are the real serializer's output shape, captured from
 * the live action. Only the HTTP transport is stubbed — `observeTurn` →
 * `FlowStreamProcessor` → `flowDataStream.ingest` all run for real.
 */
import { AgenticProcess, TypeId, dataManager } from '@sdk';
import { FlowData } from '@sdk/flow_processing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROC_ID = '1c0f3e10-bea5-429e-8270-56dba77915b1';
const PROC_TYPEID = new TypeId(AgenticProcess.type, PROC_ID);

const HISTORY_TAIL_ID = '11111111-1111-4111-8111-111111111111';
const PROMPT_ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const REPLY_ENTRY_ID = '33333333-3333-4333-8333-333333333333';

/** One drained turn, as the backend serializes it onto the SSE stream. */
const TURN_WIRE =
  `<flow-user-message i="0" t="2026-08-26T09:18:01.000Z" data-type="string"` +
  ` subtype="user_message" observation-kind="live" role="user"` +
  ` transcript-entry-id="${PROMPT_ENTRY_ID}">DRAINED-PROMPT</flow-user-message>\n` +
  `<flow-chat i="1" t="2026-08-26T09:18:02.000Z" data-type="string"` +
  ` subtype="assistant_message" observation-kind="live" role="assistant"` +
  ` transcript-entry-id="${REPLY_ENTRY_ID}">HEAD-OUTPUT</flow-chat>\n`;

function openBody() {
  let push: (chunk: string) => void = () => {};
  let close: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      push = (chunk) => controller.enqueue(enc.encode(chunk));
      close = () => controller.close();
    },
  });
  return { body, push: (c: string) => push(c), close: () => close() };
}

describe('FLOWPAD-1981 — observe-turn resume position', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  it('states the last entry it was DELIVERED, not the last one history gave it', async () => {
    const ap = new AgenticProcess({ id: PROC_ID, pty_mode: true, visible: false });
    dataManager.register_new_entity(PROC_TYPEID, ap);

    // The pane loaded history on mount — the shape `loadHistory` builds, where
    // the typed `process_entry` payload IS present.
    const settled = FlowData.fromJSON({
      flow_value: 'earlier answer',
      attributes: {
        'element-type': 'chat',
        'data-type': 'string',
        role: 'assistant',
        subtype: 'assistant_message',
        t: '2026-08-26T09:00:00.000Z',
      },
      index: 1,
      created_time: '2026-08-26T09:00:00.000Z',
      process_entry: { transcript_entry: { id: HISTORY_TAIL_ID, kind: 'assistant_message' } },
    } as never);
    settled.markReady();
    ap.flowDataStream.ingest(settled);

    const stated: Array<unknown> = [];
    let current = openBody();
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: any) => {
      if (info?.name === 'observe-turn') {
        stated.push(info.bodyParameters?.after_entry_id);
        return { body: current.body } as unknown as Response;
      }
      return undefined as unknown as Response;
    });

    // First observation: history is genuinely all this client holds.
    let observing = ap.observeTurn();
    await vi.waitFor(() => expect(stated.length).toBe(1));
    expect(stated[0]).toBe(HISTORY_TAIL_ID);

    current.push(TURN_WIRE);
    await vi.waitFor(() =>
      expect(
        ap.flowDataStream.items.some((i) => String(i.content ?? '').includes('HEAD-OUTPUT')),
      ).toBe(true),
    );
    current.close();
    await observing;

    // The turn ended and the pane re-opens for the next one (a chained drain).
    current = openBody();
    observing = ap.observeTurn();
    await vi.waitFor(() => expect(stated.length).toBe(2));
    current.close();
    await observing;

    expect(
      stated[1],
      'the re-open must resume after the turn just rendered; re-stating the ' +
        'history position makes the backend replay it and the pane show it twice',
    ).toBe(REPLY_ENTRY_ID);
  });
});
