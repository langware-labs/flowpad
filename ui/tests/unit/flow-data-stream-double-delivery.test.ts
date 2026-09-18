import { AgenticProcess, dataManager } from '@sdk';
import { FlowData, FlowDataSource } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { FlowEvents } from '@sdk/flow_processing/flow-events';
import { FlowStreamProcessor } from '@sdk/flow_processing/flow-stream-processor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * One assistant message, delivered twice, renders twice.
 *
 * A vibe chat that started the turn reads the answer off the prompt's own
 * stream, and the SAME message also arrives on the WS broadcast. Each path
 * mints its own `group-id`, and `FlowDataStream.ingest` only de-duplicates
 * assistant chat by that id — so both copies land in `items` and the chat shows
 * the answer twice until a reload replays history (which holds one).
 *
 * Observed live (oss 4098, Neti session b83fa550, 2026-09-18): the same text,
 * same `t=2026-09-18T06:40:39.075Z`, once with `source=websocket`
 * `group-id=g-1789713639558-8hvztx` and once with `source=stream`
 * `group-id=g-1789713695688-vypoep`.
 *
 * Both entries below are the product's own: the WS copy goes through
 * `APIEntity.handleFlowData` (what `DataManager.onFlowData` calls), and the
 * streamed copy through a real `FlowStreamProcessor` wired to
 * `flowDataStream.ingest` exactly as `AgenticProcess.prompt` wires it.
 */
describe('one answer delivered on both paths', () => {
  const PROCESS_ID = '00000000-0000-4000-8000-0000000000aa';
  const SAID_AT = '2026-09-18T06:40:39.075Z';
  const ANSWER = 'תחשבו על זה כמו הזמנה במסעדה: אתם קוראים למלצר, והמלצר חוזר עם תשובה.';

  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    await dataManager.clearCache();
  });

  // What DataManager.onFlowData builds for a broadcast frame.
  const broadcastCopy = () => {
    const flowData = new FlowData(FlowElementTypes.CHAT, ANSWER, {
      'element-type': 'chat',
      'data-type': 'string',
      role: 'assistant',
      t: SAID_AT,
      i: '404',
      'group-id': 'g-1789713639558-8hvztx',
    });
    flowData.source = FlowDataSource.WebSocket;
    return flowData;
  };

  // What the prompt's own stream carries: same message, its own group id.
  const streamedFrame =
    `<flow-chat i="409" t="${SAID_AT}" data-type="string" role="assistant"` +
    ` group-id="g-1789713695688-vypoep" source="stream">${ANSWER}</flow-chat>\n`;

  const chatItems = (process: AgenticProcess) =>
    process.flowDataStream.items.filter((item) => item.elementType === FlowElementTypes.CHAT);

  it('keeps one copy of the answer', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID });

    // 1. the WS broadcast arrives (APIEntity.handleFlowData → ingest)
    process.handleFlowData(broadcastCopy());

    // 2. the turn's own stream carries the same message (AgenticProcess.prompt wiring)
    const processor = new FlowStreamProcessor();
    processor.on(FlowEvents.DATA, (fd: FlowData) => process.flowDataStream.ingest(fd));
    processor.process_chunk(streamedFrame);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chatItems(process).map((item) => String(item.content))).toEqual([ANSWER]);
  });
});
