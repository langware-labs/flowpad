import { describe, expect, it } from 'vitest';

import { FlowData, FlowElementTypes } from '@sdk';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';

const frame = (type: string, data: unknown, index: number) =>
  new FlowData(type, typeof data === 'string' ? data : JSON.stringify(data), {
    i: String(index),
    t: new Date(Date.UTC(2026, 6, 27, 12, 0, index)).toISOString(),
    'data-type': typeof data === 'string' ? 'string' : 'object',
  });

describe('groupTurnEvents — worker unavailable', () => {
  it('keeps the recovery entry as its own turn instead of a dense tool run', () => {
    const groups = groupTurnEvents([
      frame(FlowElementTypes.ERROR, 'provider error', 0),
      frame(FlowElementTypes.WORKER_UNAVAILABLE, { worker_type: 'claude_code', message: 'Weekly limit reached' }, 1),
      frame(FlowElementTypes.CHAT, 'next response', 2),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['dense', 'worker-unavailable', 'message']);
  });
});
