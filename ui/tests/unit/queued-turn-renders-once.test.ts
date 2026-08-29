/**
 * FLOWPAD-2022 — a queue-drained turn must render ONCE.
 *
 * A turn the user SENT streams back over that client's own `prompt()` response
 * and nothing else. A turn the BACKEND starts — the prompt queue draining when
 * the worker frees up (`_maybe_drain_queue` → `prompt` → `headless_prompt` →
 * `run_headless_turn`) — is different: `run_headless_turn` publishes every
 * worker frame with `process.emit_flow_data(fd)`, reaching EVERY watcher over
 * the entity WebSocket, and this client (not prompting) also has
 * `useObservedTurn` open `observe-turn` for the same turn — legitimately so,
 * since that stream is the ONLY source for a turn a genuinely different client
 * is driving (no WS broadcast happens for that case; see `useObservedTurn.ts`'s
 * doc comment and `useObservedTurn.test.tsx`, which cover that this hook must
 * keep opening `observe-turn` for a busy headless process). Both channels are
 * needed in general, so both stay open; this test is about what happens when
 * they both carry the SAME message for the SAME turn.
 *
 * The two frames do not look alike — observe-turn carries `group-id` + `i`
 * (built by `entry_to_flowdata` from the transcript), the WS frame carries
 * neither — so `_isDuplicateChunk` (keyed on identity) can't match them. The
 * fix is `FlowDataStream._findDuplicateOpenGroup`: before either ingestion
 * mode starts a NEW group, it checks whether some other still-open group
 * (opened via the other mode) already holds this exact content, and drops the
 * repeat instead of appending it as new content.
 *
 * Both frames below are VERBATIM from a drained queue entry on a live backend
 * (agentic_process 1c0f3e10, instance `prod`) — the observe-turn element is its
 * `FlowData.to_xml()` wire form, the WS object is the envelope
 * `DataManager.onFlowData` receives.
 */
import { AgenticProcess, TypeId, dataManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROC_ID = '1c0f3e10-bea5-429e-8270-56dba77915b1';
const PROC_TYPEID = new TypeId(AgenticProcess.type, PROC_ID);
const TOKEN = 'TOKEN-INDIA-2022';

/** Channel B — one `observe-turn` frame, as the backend serializes it. */
const OBSERVE_TURN_XML =
  `<chat i="5725" t="2026-08-23T13:38:03.231Z" data-type="string" subtype="assistant_message"` +
  ` observation-kind="live" role="assistant" group-id="g-1787492283616-4f0bqb">${TOKEN}</chat>`;

/** Channel A — the same message, as `emit_flow_data` publishes it on the WS. */
const WS_ENVELOPE = {
  element_type: 'chat',
  data_type: 'string',
  content: TOKEN,
  attributes: {
    'element-type': 'chat',
    'data-type': 'string',
    role: 'assistant',
    t: '2026-08-23T13:38:04.009314Z',
  },
};

describe('FLOWPAD-2022 — queued prompt renders once', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  it('does not write the drained turn twice when both live channels carry it', async () => {
    const ap = new AgenticProcess({ id: PROC_ID, pty_mode: false, visible: false });
    dataManager.register_new_entity(PROC_TYPEID, ap);

    // Stand in for the HTTP transport only: the stream body below is real wire
    // bytes, and `observeTurn` -> FlowStreamProcessor -> flowDataStream.ingest
    // all run for real.
    let push: (chunk: string) => void = () => {};
    let close: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        push = (chunk) => controller.enqueue(enc.encode(chunk));
        close = () => controller.close();
      },
    });
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: any) => {
      if (info?.name === 'observe-turn') return { body } as unknown as Response;
      return undefined as unknown as Response;
    });

    // The pane opens the observation (useObservedTurn: busy && !isPrompting) —
    // exactly as it must for a headless queue-drained turn.
    const observing = ap.observeTurn();
    push(OBSERVE_TURN_XML);
    await vi.waitFor(() =>
      expect(ap.flowDataStream.items.some((i) => i.elementType === 'chat')).toBe(true),
    );

    // …and while it is still open, the WS delivers the very same message,
    // because the backend ran this turn itself via `emit_flow_data`.
    (dataManager as unknown as { onFlowData: (t: TypeId, j: unknown) => void }).onFlowData(
      PROC_TYPEID,
      WS_ENVELOPE,
    );

    close();
    await observing;

    const chat = ap.flowDataStream.items.filter((i) => i.elementType === 'chat');
    const text = chat.map((i) => String(i.content ?? '')).join('');
    expect(text, 'the agent said it once; the pane must not show it twice').toBe(TOKEN);
  });
});
