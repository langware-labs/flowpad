import { describe, expect, it } from 'vitest';
import { RAIL_ITEMS } from '@src/components/collapsed-sidebar/rail-visibility';

describe('RAIL_ITEMS', () => {
  it('is the stream inbox, then connections, and nothing else', () => {
    // Every other screen is opened by asking for it in the top bar (the smart
    // navigator). Stream Inbox stays ungated: a logout purges the hub's
    // conversations, and its screen is where "Login required" brings the user back in.
    expect(RAIL_ITEMS).toEqual(['stream_inbox', 'credentials']);
  });
});
