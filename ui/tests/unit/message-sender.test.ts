import { describe, expect, it } from 'vitest';
import { authoredBy, SenderKind, senderOf } from '@sdk/models/MessageSender';

// The TS twin of tests/unit/test_message_sender.py: one wire grammar on both tiers.
describe('senderOf', () => {
  it.each([
    ['u-1', { kind: SenderKind.User, id: 'u-1' }],
    ['agent:a-1', { kind: SenderKind.Agent, id: 'a-1' }],
    ['gmail:a@b.test', { kind: SenderKind.External, channel: 'gmail', address: 'a@b.test' }],
    ['gmail:unknown', { kind: SenderKind.External, channel: 'gmail', address: '' }],
    ['', null],
  ])('a hub row with sender_id %s names %j', (wire, expected) => {
    expect(senderOf({ sender_id: wire })).toEqual(expected);
  });

  it('prefers the typed sender the backend projected', () => {
    expect(senderOf({ sender: { kind: SenderKind.Agent, id: 'a-1' }, sender_id: 'cloud-user' })?.kind).toBe(SenderKind.Agent);
  });
});

describe('authoredBy', () => {
  it('is one of our user ids or any agent, never a stranger or nobody', () => {
    expect(authoredBy(senderOf({ sender_id: 'me-cloud' }), ['me-local', 'me-cloud'])).toBe(true);
    expect(authoredBy(senderOf({ sender_id: 'agent:a-1' }), [])).toBe(true);
    expect(authoredBy(senderOf({ sender_id: 'gmail:me-local' }), ['me-local'])).toBe(false);
    expect(authoredBy(null, [undefined])).toBe(false);
  });
});
