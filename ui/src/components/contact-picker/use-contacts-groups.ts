import { useMemo } from 'react';
import { ContactsGroup, QueryRequest, type ConversationParticipant } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { combineGroups } from './computed-groups';
import { useComputedGroups } from './use-computed-groups';
import { participantKey } from './use-contacts';

/**
 * All contacts groups: computed groups (frontend-derived rosters like
 * "Project Members") pinned first, then the stored address-book groups
 * created from the inbox. Feeds the ContactPicker's group rows — selecting a
 * group bulk-adds its members as individual participants.
 */
export function useContactsGroups(enabled: boolean = true): { groups: ContactsGroup[]; refetch: () => void } {
  const request = useMemo(() => new QueryRequest({ type: ContactsGroup.type }), []);
  const { data = [], refetch } = useEntitiesQuery<ContactsGroup>(request, { enabled });
  const computed = useComputedGroups(enabled);
  const groups = useMemo(() => combineGroups(computed, data), [computed, data]);
  return { groups, refetch: () => void refetch() };
}

/** Filter groups by a name query (case-insensitive). Empty → all. */
export function filterGroups(groups: ContactsGroup[], query: string): ContactsGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((g) => (g.displayName ?? '').toLowerCase().includes(q));
}

/**
 * Merge a group's members into a participant selection, deduped by
 * `participantKey` — the "add a few members together" expansion.
 * `excludeUserId` drops that user (computed rosters like Project Members
 * include self).
 */
export function mergeGroupMembers(
  current: ConversationParticipant[],
  members: ConversationParticipant[],
  excludeUserId?: string,
): ConversationParticipant[] {
  const seen = new Set(current.map(participantKey).filter(Boolean));
  const next = [...current];
  for (const member of members) {
    if (excludeUserId && member.user_id === excludeUserId) continue;
    const key = participantKey(member);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(member);
  }
  return next;
}
