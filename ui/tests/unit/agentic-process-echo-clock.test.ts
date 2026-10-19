/**
 * A just-sent prompt stays ABOVE the reply it caused when the browser's clock runs ahead of
 * the worker host's. The stream is ordered by timestamp and every live frame carries the
 * host's clock, so the echo must not carry the browser's.
 */
import { AgenticProcess, FlowData, FlowElementTypes } from '@sdk';
import { describe, expect, it } from 'vitest';

const HOST_BEHIND_MS = 3 * 60_000;

/** A process the host created (on its clock) three minutes before the browser's "now". */
function skewedProcess(id: string) {
  const hostNow = Date.now() - HOST_BEHIND_MS;
  // As the backend sends it: an ISO string.
  const process = new AgenticProcess({ id, created_date: new Date(hostNow).toISOString() as unknown as Date });
  return { process, stream: process.flowDataStream, hostAt: (offsetMs: number) => new Date(hostNow + offsetMs) };
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
    const { process, stream, hostAt } = skewedProcess('00000000-0000-4000-8000-00000000e601');

    process.appendUserMessage('Run ver and dir');
    stream.ingest(hostFrame('Windows 11 Home', hostAt(75_000)));

    expect(stream.items.map((item) => item.elementType)).toEqual([
      FlowElementTypes.USER_MESSAGE,
      FlowElementTypes.CHAT,
    ]);
  });

  it('keeps a later prompt above its reply, after everything already shown', () => {
    const { process, stream, hostAt } = skewedProcess('00000000-0000-4000-8000-00000000e602');
    stream.ingest(hostFrame('earlier answer', hostAt(10_000)));

    process.appendUserMessage('and now?');
    stream.ingest(hostFrame('next answer', hostAt(20_000)));

    expect(stream.items.map((item) => item.content)).toEqual(['earlier answer', 'and now?', 'next answer']);
  });
});
