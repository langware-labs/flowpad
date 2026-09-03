/** A constructed row must carry the owner it was given: the subclass
 *  constructor re-applies every field after `super()`, and a field missing
 *  from that list is silently reset to its default — which is how an agent's
 *  new channel was born the local user's. */
import { describe, expect, it } from 'vitest';
import { DataSource, MessageThread } from '@sdk';

const AGENT = 'agent-22222222-2222-4222-8222-222222222222';

describe('owner survives construction', () => {
  it('DataSource', () => {
    expect(new DataSource({ name: 'x', provider: 'slack', owner: AGENT }).owner).toBe(AGENT);
    expect(new DataSource({ name: 'x', provider: 'slack' }).owner).toBeNull();
  });
  it('MessageThread', () => {
    expect(new MessageThread({ channel: 'slack', thread_key: 'k', owner: AGENT }).owner).toBe(AGENT);
  });
});
