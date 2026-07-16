import { describe, expect, it } from 'vitest';
import { ContactsGroup, type ConversationParticipant } from '@sdk';
import {
  combineGroups,
  computedGroupId,
  groupActionRef,
  makeComputedGroup,
} from '@src/components/contact-picker/computed-groups';
import { mergeGroupMembers } from '@src/components/contact-picker/use-contacts-groups';

const roster: ConversationParticipant[] = [
  { user_id: 'hub-1', email: 'alice@example.com', name: 'Alice', role: 'owner' },
  { user_id: 'hub-2', email: 'bob@example.com', name: 'Bob', role: 'editor' },
];

const UUID_V45_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('computedGroupId', () => {
  it('is deterministic per (key, scope) and a valid v4/v5 uuid', () => {
    const a = computedGroupId('project-members', 'proj-1');
    expect(a).toBe(computedGroupId('project-members', 'proj-1'));
    expect(a).not.toBe(computedGroupId('project-members', 'proj-2'));
    expect(a).not.toBe(computedGroupId('workspace-members', 'proj-1'));
    expect(a).toMatch(UUID_V45_RE);
  });
});

describe('makeComputedGroup', () => {
  it('returns null without a scope entity or with an empty roster', () => {
    expect(makeComputedGroup({ key: 'k', name: 'N', scopeId: null, members: roster })).toBeNull();
    expect(makeComputedGroup({ key: 'k', name: 'N', scopeId: undefined, members: roster })).toBeNull();
    expect(makeComputedGroup({ key: 'k', name: 'N', scopeId: 'proj-1', members: [] })).toBeNull();
  });

  it('builds a computed ContactsGroup carrying the roster', () => {
    const g = makeComputedGroup({ key: 'project-members', name: 'Project Members', scopeId: 'proj-1', members: roster });
    expect(g).not.toBeNull();
    expect(g!.computed).toBe(true);
    expect(g!.contacts).toEqual(roster);
    expect(g!.id).toBe(computedGroupId('project-members', 'proj-1'));
  });

  it('computed groups refuse to save', async () => {
    const g = makeComputedGroup({ key: 'k', name: 'N', scopeId: 'proj-1', members: roster })!;
    await expect(g.save()).rejects.toThrow(/cannot be saved/i);
  });
});

describe('combineGroups', () => {
  const computed = makeComputedGroup({ key: 'k', name: 'Project Members', scopeId: 'proj-1', members: roster })!;
  const stored = new ContactsGroup({ name: 'My class', contacts: [{ email: 'x@y.z' }] });
  const empty = new ContactsGroup({ name: 'Empty' });

  it('pins computed groups first and drops only empty STORED groups', () => {
    const merged = combineGroups([computed], [empty, stored]);
    expect(merged.map((g) => g.displayName)).toEqual(['Project Members', 'My class']);
  });

  it('works with no computed groups (stored-only behavior unchanged)', () => {
    expect(combineGroups([], [empty, stored])).toEqual([stored]);
  });
});

describe('mergeGroupMembers with a computed group', () => {
  it('bulk-adds the roster deduped by participantKey', () => {
    const computed = makeComputedGroup({ key: 'k', name: 'N', scopeId: 'proj-1', members: roster })!;
    const current: ConversationParticipant[] = [{ user_id: 'hub-1', email: 'alice@example.com', name: 'Alice' }];
    const next = mergeGroupMembers(current, computed.contacts);
    expect(next).toHaveLength(2);
    expect(next.map((p) => p.user_id)).toEqual(['hub-1', 'hub-2']);
  });
});

describe('groupActionRef', () => {
  it('references a computed group by roster and a stored group by id', () => {
    const computed = makeComputedGroup({ key: 'k', name: 'N', scopeId: 'proj-1', members: roster })!;
    expect(groupActionRef(computed)).toEqual({ members: roster });
    const stored = new ContactsGroup({ id: '2c1e0f34-6f70-4c11-9a63-3f2b8f6a1d2e', name: 'My class' });
    expect(groupActionRef(stored)).toEqual({ group_id: '2c1e0f34-6f70-4c11-9a63-3f2b8f6a1d2e' });
  });
});
