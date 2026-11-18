import { useMemo } from 'react';
import { type Conversation, normalizeEmail, User } from '@sdk';
import { useRecentConversations } from '@src/hooks/use-recent-conversations';

/** How many recent contacts the picker pins above the full list. */
export const RECENT_CONTACTS_LIMIT = 5;

const identity = (value?: string | null) => (value ?? '').toLowerCase();

/**
 * The contacts of the most recent conversations, newest first, each once, at most `limit`.
 * `conversations` arrive newest first. A member is matched to a contact by hub id or email —
 * a member row and its contact do not always carry the same one.
 */
export function recentContacts(
  contacts: User[],
  conversations: Conversation[],
  limit: number = RECENT_CONTACTS_LIMIT,
): User[] {
  const byIdentity = new Map<string, User>();
  for (const contact of contacts) {
    for (const key of [contact.user_id, contact.id, normalizeEmail(contact.email)]) {
      if (key) byIdentity.set(identity(key), contact);
    }
  }
  const recent: User[] = [];
  for (const conversation of conversations) {
    for (const member of conversation.members ?? []) {
      const contact =
        byIdentity.get(identity(member.user_id)) ?? byIdentity.get(identity(normalizeEmail(member.email)));
      if (!contact || recent.includes(contact)) continue;
      recent.push(contact);
      if (recent.length === limit) return recent;
    }
  }
  return recent;
}

/** The people of the user's latest open conversations, out of `contacts` — the picker's "recent" rows. */
export function useRecentContacts(contacts: User[], enabled: boolean): User[] {
  const conversations = useRecentConversations(enabled, { limit: 30 });
  return useMemo(() => recentContacts(contacts, conversations), [contacts, conversations]);
}
