import { v5 as uuidv5 } from 'uuid';
import { ContactsGroup, type ConversationParticipant } from '@sdk';

/** Fixed namespace for computed-group ids (arbitrary constant v4). */
const COMPUTED_GROUP_NAMESPACE = '39b3d7ea-5a41-4416-a16f-4d51d84846fd';

/**
 * Deterministic v5 id per (definition key, scope entity id) — stable React
 * keys/testids across renders, valid under the TypeId v4/v5 regex. Never
 * persisted and never sent to the backend as a group_id.
 */
export function computedGroupId(definitionKey: string, scopeId: string): string {
  return uuidv5(`${definitionKey}:${scopeId}`, COMPUTED_GROUP_NAMESPACE);
}

/**
 * Build the in-memory ContactsGroup for a computed-group definition — a group
 * whose membership is derived from an entity roster (e.g. the current
 * project's participants) rather than stored. Returns null when the group is
 * unavailable (no scope entity, or an empty roster).
 */
export function makeComputedGroup(opts: {
  key: string;
  name: string;
  scopeId: string | null | undefined;
  members: ConversationParticipant[];
}): ContactsGroup | null {
  if (!opts.scopeId || opts.members.length === 0) return null;
  return new ContactsGroup({
    id: computedGroupId(opts.key, opts.scopeId),
    name: opts.name,
    contacts: opts.members,
    computed: true,
  });
}

/**
 * Merge computed groups (pinned first) with stored groups. The "hide empty
 * groups" filter applies only to stored groups — computed emptiness is
 * already handled by makeComputedGroup returning null.
 */
export function combineGroups(computed: ContactsGroup[], stored: ContactsGroup[]): ContactsGroup[] {
  return [...computed, ...stored.filter((g) => (g.contacts ?? []).length > 0)];
}

/**
 * How an action body references a contacts group: a stored group by id, a
 * computed group by its frontend-derived roster — its id resolves to nothing
 * on the backend, so it must never be sent. Keeping the branch here (next to
 * the registry) keeps that invariant in one place; the backend mirror is
 * `group_task_action._resolve_group`.
 */
export function groupActionRef(group: ContactsGroup): { group_id: string } | { members: ConversationParticipant[] } {
  return group.computed ? { members: group.contacts ?? [] } : { group_id: group.id! };
}
