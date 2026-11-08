import { describe, expect, it } from 'vitest';
import { AgentMailbox, onMailboxList, User } from '@sdk';
import { resolveEntry } from '@src/components/agents/mailbox-entries';

describe('the mailbox lists: one entry vocabulary both directions share', () => {
  const eran = new User({ id: '5f0c2b1e-8a4d-4c3b-9e2f-1a2b3c4d5e6f', name: 'Eran Shlomo', email: 'eran@langware.ai' });

  it('an entry is an address, @domain, or a contact named exactly — resolved to their email', () => {
    expect(resolveEntry('ami@langware.ai', [eran])).toBe('ami@langware.ai');
    expect(resolveEntry('@Partner.io', [eran])).toBe('@partner.io');
    expect(resolveEntry('eran shlomo', [eran])).toBe('eran@langware.ai');
    expect(resolveEntry('Eran', [eran])).toBeNull();
    expect(resolveEntry('@nodot', [eran])).toBeNull();
  });

  it('a domain entry matches its domain exactly; Blocked wins; Open to all switches Allowed off', () => {
    expect(onMailboxList(['@partner.io'], 'Joe@Partner.io')).toBe(true);
    expect(onMailboxList(['@partner.io'], 'joe@partner.io.evil.com')).toBe(false);
    const mailbox = new AgentMailbox({
      status: 'active',
      allowed_senders: ['@partner.io'],
      blocked_senders: ['spam@partner.io'],
      allowed_recipients: ['eran@langware.ai'],
      open_recipients: false,
    });
    expect(mailbox.allowed('joe@partner.io')).toBe(true);
    expect(mailbox.allowed('spam@partner.io')).toBe(false);
    expect(mailbox.maySendTo('eran@langware.ai')).toBe(true);
    expect(mailbox.maySendTo('stranger@example.com')).toBe(false);
    expect(new AgentMailbox({ status: 'active', open_senders: true }).allowed('anyone@x.io')).toBe(true);
  });
});
