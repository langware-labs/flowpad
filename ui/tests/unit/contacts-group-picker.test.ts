import { describe, expect, it } from 'vitest';
import { ContactsGroup, type ConversationParticipant } from '@sdk';
import { filterGroups, mergeGroupMembers } from '@src/components/contact-picker/use-contacts-groups';

const group = new ContactsGroup({
  name: 'My class',
  contacts: [
    { user_id: 'hub-1', email: 'alice@example.com', name: 'Alice' },
    { email: 'bob@example.com', name: 'Bob' },
    { email: 'carol@example.com', name: 'Carol' },
  ],
});

describe('mergeGroupMembers — the one-click bulk add', () => {
  it('appends every member to an empty selection', () => {
    const next = mergeGroupMembers([], group.contacts);
    expect(next.map((p) => p.email)).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('dedupes against already-selected participants by participantKey', () => {
    const current: ConversationParticipant[] = [
      { user_id: 'hub-1', email: 'alice@example.com', name: 'Alice' }, // user_id key
      { email: 'BOB@example.com', name: 'Bobby' }, // email key, case-insensitive
    ];
    const next = mergeGroupMembers(current, group.contacts);
    expect(next).toHaveLength(3);
    expect(next.map((p) => p.email)).toEqual(['alice@example.com', 'BOB@example.com', 'carol@example.com']);
  });

  it('dedupes members WITHIN the group and skips keyless entries', () => {
    const messy: ConversationParticipant[] = [
      { email: 'x@y.z', name: 'X' },
      { email: 'X@Y.Z', name: 'X again' },
      { email: null, name: null }, // keyless — never added
    ];
    expect(mergeGroupMembers([], messy)).toHaveLength(1);
  });

  it('drops the excluded user (self in a computed roster)', () => {
    const next = mergeGroupMembers([], group.contacts, 'hub-1');
    expect(next.map((p) => p.email)).toEqual(['bob@example.com', 'carol@example.com']);
  });
});

describe('filterGroups', () => {
  it('matches group names case-insensitively; empty query returns all', () => {
    const groups = [group, new ContactsGroup({ name: 'Work' })];
    expect(filterGroups(groups, '')).toHaveLength(2);
    expect(filterGroups(groups, 'class').map((g) => g.displayName)).toEqual(['My class']);
    expect(filterGroups(groups, 'nope')).toHaveLength(0);
  });
});
