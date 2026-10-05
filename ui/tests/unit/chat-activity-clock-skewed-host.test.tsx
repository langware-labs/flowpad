/**
 * A turn's elapsed clock starts at 0:00 even when the worker host's clock is behind the
 * browser's. The just-sent prompt's echo is stamped on the HOST's clock so it sorts above the
 * reply (see agentic-process-echo-clock.test.ts); the clock measures against the browser's
 * `now`, so it must anchor on the echo's browser submit time — on a VM 2.6 min behind the
 * pane read "3:08" the moment the turn started.
 */
import { cleanup, render } from '@testing-library/react';
import { AgenticProcess, FlowData, FlowDataStream } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same single seam as chat-activity-line-self-sourcing: the websocket reflection of the entity.
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: null }),
  useWatch: () => {},
}));

import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';

afterEach(() => cleanup());

describe('ChatActivityLine on a host whose clock is behind the browser', () => {
  it('starts the elapsed clock at the prompt, not minutes in', () => {
    const hostNow = new Date(Date.now() - 3 * 60_000);
    const real = new AgenticProcess({
      id: '00000000-0000-4000-8000-00000000e603',
      created_date: hostNow.toISOString() as unknown as Date,
    });
    real.appendUserMessage('Live order check');
    const echo = real.flowDataStream.items[0] as FlowData;

    const stream = new FlowDataStream('skewed-host-clock');
    stream.ingestBatch([echo]);
    const process = {
      id: 'p-1',
      session_id: 's-1',
      status: 'running',
      busy: true,
      isPrompting: false,
      flowDataStream: stream,
      on: () => () => {},
      off: () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { container } = render(<ChatActivityLine process={process as any} />);

    expect(container.textContent).toMatch(/· 0:0\d/);
  });
});
