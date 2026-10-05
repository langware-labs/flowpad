/**
 * A turn's elapsed clock starts at 0:00 even when the worker host's clock is behind the
 * browser's: it measures against the browser's now, so it anchors on the echo's browser
 * submit time, not on its host-clock `t` (which kept it ordered above the reply).
 */
import { cleanup, render } from '@testing-library/react';
import { AgenticProcess } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same single seam as chat-activity-line-self-sourcing: the websocket reflection of the entity.
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: null }),
  useWatch: () => {},
}));

import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';
import { fakeProcess } from '../utils/fake-process';

afterEach(() => cleanup());

describe('ChatActivityLine on a host whose clock is behind the browser', () => {
  it('starts the elapsed clock at the prompt, not minutes in', () => {
    const hostNow = new Date(Date.now() - 3 * 60_000).toISOString();
    const real = new AgenticProcess({
      id: '00000000-0000-4000-8000-00000000e603',
      created_date: hostNow as unknown as Date,
    });
    real.appendUserMessage('Live order check');

    const process = fakeProcess({ frames: [...real.flowDataStream.items] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { container } = render(<ChatActivityLine process={process as any} />);

    expect(container.textContent).toMatch(/· 0:0\d/);
  });
});
