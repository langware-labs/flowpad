/**
 * The prompt a user just sent stays ABOVE the reply it caused, even when the browser's clock
 * runs ahead of the worker host's (a Windows VM ~2.6 min behind the Mac whose browser showed
 * its pane rendered Claude's answer above "You", 2026-10-05).
 *
 * The stream is ordered by timestamp. Every live frame carries the host's clock; the echo was
 * stamped with the browser's `new Date()`, so a browser ahead of the host sorted it last.
 */
import { AgenticProcess, FlowData, FlowElementTypes } from '@sdk';
import { describe, expect, it } from 'vitest';

interface StreamInternals {
  flowDataStream: { ingest(item: FlowData): void; items: readonly FlowData[] };
}

/** A live frame as the worker host stamps it. */
function hostFrame(content: string, at: Date): FlowData {
  const frame = FlowData.fromJSON({
    flow_value: content,
    attributes: {
      'element-type': FlowElementTypes.CHAT,
      'data-type': 'string',
      role: 'assistant',
      t: at.toISOString(),
    },
  });
  frame.markReady();
  return frame;
}

describe('AgenticProcess optimistic echo and a skewed browser clock', () => {
  it('keeps a first prompt above its reply when the host clock is behind the browser', () => {
    // The host created this process (its clock) three minutes before the browser's "now".
    const hostNow = new Date(Date.now() - 3 * 60_000);
    const process = new AgenticProcess({
      id: '00000000-0000-4000-8000-00000000e601',
      created_date: hostNow.toISOString() as unknown as Date,
    }); // as the backend sends it
    const stream = (process as unknown as StreamInternals).flowDataStream;

    process.appendUserMessage('Run ver and dir');
    stream.ingest(hostFrame('Windows 11 Home', new Date(hostNow.getTime() + 75_000)));

    expect(stream.items.map((item) => item.elementType)).toEqual([
      FlowElementTypes.USER_MESSAGE,
      FlowElementTypes.CHAT,
    ]);
  });

  it('keeps a later prompt above its reply, after everything already shown', () => {
    const hostNow = new Date(Date.now() - 3 * 60_000);
    const process = new AgenticProcess({
      id: '00000000-0000-4000-8000-00000000e602',
      created_date: hostNow.toISOString() as unknown as Date,
    }); // as the backend sends it
    const stream = (process as unknown as StreamInternals).flowDataStream;
    stream.ingest(hostFrame('earlier answer', new Date(hostNow.getTime() + 10_000)));

    process.appendUserMessage('and now?');
    stream.ingest(hostFrame('next answer', new Date(hostNow.getTime() + 20_000)));

    expect(stream.items.map((item) => item.content)).toEqual(['earlier answer', 'and now?', 'next answer']);
  });
});
