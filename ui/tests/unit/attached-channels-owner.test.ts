/** The bar's owner rule mirrors the backend's `owner_of`, so a row the
 *  backfill has not touched still lands in the right inbox. */
import { describe, expect, it } from 'vitest';
import { ownerOf } from '@src/components/inbox-view/channel-owner';

const AGENT = '22222222-2222-4222-8222-222222222222';

describe('ownerOf', () => {
  it('an explicit owner wins', () => {
    expect(ownerOf({ owner: `agent-${AGENT}`, config: { agent_id: 'other' } })).toBe(`agent-${AGENT}`);
  });
  it('a legacy agent row is the agent its config names', () => {
    expect(ownerOf({ owner: null, config: { agent_id: AGENT } })).toBe(`agent-${AGENT}`);
  });
  it('a bare legacy row answers null — the local user, resolved by the caller', () => {
    expect(ownerOf({ owner: null, config: {} })).toBeNull();
  });
});
