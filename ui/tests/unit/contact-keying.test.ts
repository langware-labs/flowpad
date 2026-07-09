/**
 * Canonical contact keying — the identity helpers shared by ContactPicker,
 * AddressBookButton, and useConversationsForContacts. Locks the "email OR
 * user_id OR both" contract so a contact known only by hub id is still keyed
 * and selectable.
 */
import { describe, expect, it } from 'vitest';
import { User } from '@sdk';
import {
  participantFromContact,
  participantKey,
} from '@src/components/contact-picker/use-contacts';

describe('participantKey', () => {
  it('prefers user_id, then email, then name, lowercased', () => {
    expect(participantKey({ user_id: 'HUB-1', email: 'a@x.io', name: 'A' })).toBe('hub-1');
    expect(participantKey({ email: 'A@x.io', name: 'A' })).toBe('a@x.io');
    expect(participantKey({ name: 'Alice' })).toBe('alice');
    expect(participantKey({})).toBe('');
  });
});

describe('participantFromContact', () => {
  it('carries the foreign hub user_id when present', () => {
    const u = new User({ id: 'local-1', email: 'g@x.io', name: 'Gadi', user_id: 'hub-gadi' });
    const p = participantFromContact(u);
    expect(p.user_id).toBe('hub-gadi');
    expect(p.email).toBe('g@x.io');
  });

  it('keys an email-less, user_id-only contact by its user_id', () => {
    const u = new User({ id: 'local-2', user_id: 'hub-nir', name: 'Nir' });
    const p = participantFromContact(u);
    expect(p.user_id).toBe('hub-nir');
    expect(participantKey(p)).toBe('hub-nir');
  });

  it('falls back to the local id for a remote contact with no hub user_id', () => {
    const u = new User({ id: 'local-3', email: 'z@x.io', remote: true });
    expect(participantFromContact(u).user_id).toBe('local-3');
  });

  it('carries no user_id for a purely-local contact (email only)', () => {
    const u = new User({ id: 'local-4', email: 'z@x.io' });
    expect(participantFromContact(u).user_id).toBeUndefined();
  });
});
