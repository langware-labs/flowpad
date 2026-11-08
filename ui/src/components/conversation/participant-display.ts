import { ROLE_ORDER, ROLE_GRANTS, newInviteRoles, grantableRoleSet, canManageRoles, type ConversationParticipant } from '@sdk';
import type { ContactKey } from '@src/hooks/use-contact-permissions';

/** Identity passed to {@link ContactPermissionsDialog} — a permissions key plus
 *  a display name. */
export type ContactIdentity = ContactKey & { name?: string | null };

/** Build a permissions contact from a participant/member row, or `null` when it
 *  has neither a user id nor an email (nothing to key permissions on). Accepts
 *  any row carrying the three snake_case fields, so both the conversation
 *  participant list and the member roster share one implementation. */
export function contactFromParticipant(row: {
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
}): ContactIdentity | null {
  const userId = row.user_id?.trim() || null;
  const email = row.email?.trim() || null;
  const name = row.name?.trim() || null;
  if (!userId && !email) return null;
  return { userId, email, name };
}

/** Same cap as the hub's ``NAME_FROM_EMAIL_MAX``. */
const NAME_FROM_EMAIL_MAX = 20;

/** ``john.doe@x`` -> ``John Doe``, capped — mirrors the hub's ``name_from_email``. */
export function nameFromEmail(email: string | null | undefined): string {
  const local = (email ?? '').trim().split('@')[0] ?? '';
  return local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, NAME_FROM_EMAIL_MAX)
    .trim();
}

/** The one name builder for a person: never empty, never "unknown", never an
 *  email. A real name, else a short name from the email, else a short id. */
export function personName(
  person:
    | { name?: string | null; email?: string | null; user_id?: string | null; id?: string | null }
    | null
    | undefined,
): string {
  const name = person?.name?.trim();
  if (name && !name.includes('@')) return name;
  const fromEmail = nameFromEmail(person?.email || (name ?? ''));
  if (fromEmail) return fromEmail;
  const id = (person?.user_id || person?.id || '').trim();
  return id ? `User ${id.slice(0, 6)}` : 'Guest';
}

export function participantLabel(participant: ConversationParticipant | null | undefined): string {
  return personName(participant);
}

/** The second line under a person's name in a list: their email, when known.
 *  The hub never discloses another member's email, so a hub-only contact has none. */
export function participantSubtitle(
  participant: { name?: string | null; email?: string | null } | null | undefined,
): string | null {
  return participant?.email?.trim() || null;
}

/** Name-only display — never the full email. Falls back to the email's local
 *  part (before @) so compact surfaces show a name-ish token, not an address. */
export function participantName(participant: ConversationParticipant | null | undefined): string {
  return personName(participant);
}

/** True when a participant row is the given user — matched by hub ``user_id``
 *  or (case-insensitive) email. Either identifier may be absent on one side; an
 *  empty value never matches. Pass the auth user (cloud when logged in, else
 *  local). */
export function participantIsUser(
  participant: ConversationParticipant | null | undefined,
  user: { id?: string | null; email?: string | null } | null | undefined,
): boolean {
  if (!participant || !user) return false;
  const id = (user.id ?? '').trim();
  if (id && participant.user_id === id) return true;
  const email = (user.email ?? '').trim().toLowerCase();
  if (email && (participant.email ?? '').trim().toLowerCase() === email) return true;
  return false;
}

export function participantLabelByUserId(
  participants: ConversationParticipant[] | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!userId) return null;
  const participant = participants?.find((p) => p.user_id === userId);
  return participant ? participantLabel(participant) : null;
}

/** Marker rendered when a message carries an authenticated `sender_id` that
 *  does NOT resolve to anyone in the member roster, AND no other cushion
 *  (sender_name, creator) is available. This is an ALERT state — identity
 *  is hub-authoritative, so a non-resolving id (with the roster confirmed
 *  loaded) means the local roster is stale or, in the worst case, a spoof
 *  attempt the hub should have blocked. Reserved for the genuine unknown
 *  case; legitimate gaps (loading roster, departed member, cross-instance
 *  bundle import) fall back through the tiered chain first. Still a name, never "unknown". */
export function unresolvedSenderLabel(senderId: string): string {
  return `⚠ ${personName({ user_id: senderId })}`;
}

/** Module-level dedup so the unresolved-sender warn fires AT MOST once per
 *  (sender_id, conversation) pair — callers invoke it from a useEffect, so
 *  this also protects against re-renders without an effect dep change. */
const _warnedUnresolved = new Set<string>();

/** Emit a one-time console.warn for a sender_id that didn't resolve. Pass
 *  a `conversationId` so the same id surfacing in two different
 *  conversations is logged once per conversation. */
export function warnUnresolvedSender(
  senderId: string,
  conversationId: string | null | undefined,
  rosterSize: number,
): void {
  const key = `${conversationId ?? ''}::${senderId}`;
  if (_warnedUnresolved.has(key)) return;
  _warnedUnresolved.add(key);
  console.warn(
    `[conversation] unresolved sender_id="${senderId}" in conv="${conversationId ?? '?'}" — ` +
      `not in member roster (${rosterSize} members). Showing alert label.`,
  );
}

/** Short display label for a participant's role. Returns an empty string
 *  when the role is absent so callers can render conditionally. */
export function participantRoles(participant: ConversationParticipant | null | undefined): string[] {
  return participant?.roles ?? [];
}
export function participantRoleLabel(participant: ConversationParticipant | null | undefined): string {
  return participantRoles(participant).join(', ');
}
export const PARENT_ROLES: readonly string[] = ROLE_ORDER;
export const CONFERRABLE_ROLES: readonly string[] = ROLE_GRANTS.owner;
export function participantIsOwner(participant: ConversationParticipant | null | undefined): boolean {
  return participantRoles(participant).includes('owner');
}
export function assignableRoles(me: ConversationParticipant | null | undefined, target: ConversationParticipant | null | undefined): string[] {
  if (!target?.user_id || me?.user_id === target.user_id) return [];
  if (!canManageRoles(participantRoles(me), participantRoles(target))) return [];
  return grantableRoleSet(participantRoles(me));
}
export function grantableRoles(me: ConversationParticipant | null | undefined, entityType?: string): string[] {
  return newInviteRoles(participantRoles(me), entityType ?? "");
}
export function canInviteMembers(me: ConversationParticipant | null | undefined, entityType?: string): boolean {
  return grantableRoles(me, entityType).length > 0;
}

/** Initials of any display label — the avatar fallback for participants AND
 *  non-participant identities (an Agent). Splits on separators, caps at
 *  `maxChars`, and falls back to "?" so the avatar never goes blank. */
export function initialsFromLabel(label: string | null | undefined, maxChars: 1 | 2 = 2): string {
  const text = (label ?? '').trim();
  if (!text) return '?';
  const parts = text.split(/[\s@._-]+/).filter(Boolean);
  const initials =
    parts.length === 0
      ? text.slice(0, 1)
      : parts.length === 1
        ? parts[0].slice(0, maxChars)
        : parts[0][0] + parts[1][0];
  return initials.slice(0, maxChars).toUpperCase();
}

/** First-letter initials for the participant avatar fallback. */
export function participantInitials(participant: ConversationParticipant | null | undefined): string {
  const label = participantLabel(participant);
  return initialsFromLabel(label) || '?';
}
