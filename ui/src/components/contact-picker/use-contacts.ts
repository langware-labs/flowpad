import { useMemo } from 'react';
import { ConversationParticipant, normalizeEmail, QueryRequest, User } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/** Shared email shape check, used by every recipient-entry surface. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Stable identity key for a participant. user_id wins (cross-machine stable),
 * then email, then name as a last resort. The single canonical keying — used by
 * ContactPicker / AddressBookButton (dedup + selected-state) AND
 * useConversationsForContacts (subset match), so the picker and the matcher
 * always agree on "the same person".
 */
export function participantKey(p: ConversationParticipant): string {
  return (p.user_id || p.email || p.name || '').trim().toLowerCase();
}

/**
 * Build a ConversationParticipant from a contact User. Carry the contact's
 * identity so a contact known only by hub id (no email) is still selectable:
 * prefer the foreign hub ``user_id``, else the local entity ``id`` for a remote
 * contact. A purely-local contact (has email, no hub id) carries none.
 */
export function participantFromContact(u: User): ConversationParticipant {
  const participant: ConversationParticipant = {
    email: normalizeEmail(u.email),
    name: u.name ?? null,
  };
  const hubId = u.user_id || (u.remote ? u.id : undefined);
  if (hubId) {
    participant.user_id = hubId;
  }
  return participant;
}

/**
 * The single contact source: all known ``User`` entities minus ``excludeUserId``
 * (typically the local user). Shared by ContactPicker (typeahead) and
 * AddressBookButton (checkbox multi-select) so they list the same people.
 */
export function useContacts(
  excludeUserId?: string | null,
  enabled: boolean = true,
): { contacts: User[]; refetch: () => void } {
  const usersRequest = useMemo(() => new QueryRequest({ type: User.type }), []);
  const { data: allUsers = [], refetch } = useEntitiesQuery<User>(usersRequest, { enabled });
  const contacts = useMemo(
    () => allUsers.filter((u) => !excludeUserId || u.id !== excludeUserId),
    [allUsers, excludeUserId],
  );
  return { contacts, refetch };
}

/** Filter contacts by a name/email query (case-insensitive). Empty → all. */
export function filterContacts(contacts: User[], query: string): User[] {
  const q = query.trim().toLowerCase();
  if (!q) return contacts;
  return contacts.filter(
    (u) =>
      (u.name ?? '').toLowerCase().includes(q) ||
      (u.email ?? '').toLowerCase().includes(q),
  );
}
