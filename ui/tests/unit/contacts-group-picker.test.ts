import { describe, expect, it } from 'vitest';
import { ContactsGroup, type ConversationParticipant } from '@sdk';
import { filterGroups, mergeGroupMembers } from '@src/components/contact-picker/use-contacts-groups';
import { teamParticipant } from '@src/components/contact-picker/use-team-suggestions';

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

describe('mergeGroupMembers — beside a picked team', () => {
  const team = teamParticipant({ id: '550e8400-e29b-41d4-a716-446655440030', name: 'zschool' });

  it('keeps the team chip and adds the group members around it', () => {
    const next = mergeGroupMembers([team], group.contacts);
    expect(next[0]).toBe(team);
    expect(next).toHaveLength(4);
  });

  it('a team is keyed by its typeid, so a person with the team name is still added', () => {
    const next = mergeGroupMembers([team], [{ name: 'zschool', email: null }]);
    expect(next).toHaveLength(2);
  });
});
