import { AgenticProcess, dataManager } from '@sdk';
import { FlowData, FlowDataSource } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { FlowEvents } from '@sdk/flow_processing/flow-events';
import { FlowStreamProcessor } from '@sdk/flow_processing/flow-stream-processor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * An answer the pane already holds, replayed, renders twice.
 *
 * The pane receives the finished answer over the WS broadcast. Later
 * `observe-turn` replays the same message — a pane that reconnects, or whose
 * `after_entry_id` watermark sits behind the transcript, gets it again. The
 * cross-channel guard in `_ingestRaw` only matches a twin whose group is still
 * OPEN, and this one closed when it completed, so the replay starts its own
 * group and the chat shows the answer twice until a reload rebuilds from
 * history (which holds one).
 *
 * Proven live (oss 4098, Neti session b83fa550, 2026-09-18) with the
 * `chat_delivery` toplog tag; the decisive line was
 * `raw_decide new_group=true open_dup=false closed_twin=true t=…T11:54:49.124Z`
 * — the pane already held that message, finished, and the existing
 * cross-channel guard only looks at OPEN groups.
 *
 * Both entries below are the product's own: the WS copy goes through
 * `APIEntity.handleFlowData` (what `DataManager.onFlowData` calls), and the
 * replayed copy through a real `FlowStreamProcessor` wired to
 * `flowDataStream.ingest` exactly as `AgenticProcess.observeTurn` wires it.
 */
describe('an answer the pane already holds, replayed by observe-turn', () => {
  const PROCESS_ID = '00000000-0000-4000-8000-0000000000aa';
  const SAID_AT = '2026-09-18T06:40:39.075Z';
  const ANSWER = 'תחשבו על זה כמו הזמנה במסעדה: אתם קוראים למלצר, והמלצר חוזר עם תשובה.';

  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    await dataManager.clearCache();
  });

  // What DataManager.onFlowData builds for a broadcast frame — the copy the
  // pane already holds, complete.
  const broadcastCopy = () => {
    const flowData = new FlowData(FlowElementTypes.CHAT, ANSWER, {
      'element-type': 'chat',
      'data-type': 'string',
      role: 'assistant',
      t: SAID_AT,
      i: '968',
    });
    flowData.source = FlowDataSource.WebSocket;
    // Not marked ready here: production leaves a groupless WS chat open, and the
    // replayed reasoning frame below is what closes (and readies) its group.
    return flowData;
  };

  // The replay opens with the turn's reasoning, exactly as the live trace showed
  // (`cur_type=reasoning` at the moment the chat arrived) — so the chat is a NEW
  // group rather than a continuation of the one the pane already holds.
  const replayedReasoning =
    `<flow-reasoning i="1189" t="2026-09-18T06:40:38.000Z" data-type="string"` +
    ` source="stream">thinking…</flow-reasoning>\n`;

  // What `observe-turn` replays when its watermark is behind the transcript:
  // the same message again, under a later transcript index.
  const replayedFrame =
    `<flow-chat i="1190" t="${SAID_AT}" data-type="string" role="assistant"` +
    ` source="stream">${ANSWER}</flow-chat>\n`;

  const chatItems = (process: AgenticProcess) =>
    process.flowDataStream.items.filter((item) => item.elementType === FlowElementTypes.CHAT);

  it('keeps one copy of the answer', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID });

    // 1. the WS broadcast arrives (APIEntity.handleFlowData → ingest)
    process.handleFlowData(broadcastCopy());

    // 2. observe-turn replays that same message (AgenticProcess.observeTurn wiring)
    const processor = new FlowStreamProcessor();
    processor.on(FlowEvents.DATA, (fd: FlowData) => process.flowDataStream.ingest(fd));
    processor.process_chunk(replayedReasoning);
    processor.process_chunk(replayedFrame);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chatItems(process).map((item) => String(item.content))).toEqual([ANSWER]);
  });
});
