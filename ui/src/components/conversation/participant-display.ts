import type { ConversationParticipant } from '@sdk';
import type { ContactKey } from '@src/hooks/use-contact-permissions';

/** Identity passed to {@link ContactPermissionsDialog} — a permissions key plus
 *  a display name. */
export type ContactIdentity = ContactKey & { name?: string | null };

/** Build a permissions contact from a participant/member row, or `null` when it
 *  has neither a user id nor an email (nothing to key permissions on). Accepts
 *  any row carrying the three snake_case fields, so both the conversation
 *  participant list and the member roster share one implementation. */
export function contactFromParticipant(
  row: { user_id?: string | null; email?: string | null; name?: string | null },
): ContactIdentity | null {
  const userId = row.user_id?.trim() || null;
  const email = row.email?.trim() || null;
  const name = row.name?.trim() || null;
  if (!userId && !email) return null;
  return { userId, email, name };
}

export function participantLabel(participant: ConversationParticipant | null | undefined): string {
  return participant?.name?.trim() || participant?.email?.trim() || 'unknown';
}

/** Name-only display — never the full email. Falls back to the email's local
 *  part (before @) so compact surfaces show a name-ish token, not an address. */
export function participantName(participant: ConversationParticipant | null | undefined): string {
  const name = participant?.name?.trim();
  if (name) return name;
  const email = participant?.email?.trim();
  if (email) return email.split('@')[0] || email;
  return 'unknown';
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
 *  bundle import) fall back through the tiered chain first. */
export const UNRESOLVED_SENDER_LABEL = '⚠ unknown sender';

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
export function participantRoleLabel(participant: ConversationParticipant | null | undefined): string {
  return participant?.role?.trim() || '';
}

/** Standard role ladder, highest first — mirrors the hub's ``ROLE_RANK``
 *  (``flowpad/hub/core/auth/role_hierarchy.py``), the single source of truth
 *  the hub's ``can_assign`` gate enforces. Index = rank (lower index = more
 *  privileged). Custom/unknown roles rank as ``null`` (not on the ladder). */
const ROLE_LADDER = ['owner', 'full-access', 'admin', 'editor', 'member', 'reader', 'guest'] as const;

/** Rank of a single standard role (0 = owner), or null for custom/unknown. */
function roleRank(role: string | null | undefined): number | null {
  const idx = ROLE_LADDER.indexOf((role ?? '').trim().toLowerCase() as (typeof ROLE_LADDER)[number]);
  return idx === -1 ? null : idx;
}

/** Highest (most privileged) standard rank from a participant's role field.
 *  The hub joins multi-role members as ``"a, b"`` — take the best rank. */
export function participantRank(participant: ConversationParticipant | null | undefined): number | null {
  const raw = participant?.role ?? '';
  let best: number | null = null;
  for (const part of raw.split(',')) {
    const r = roleRank(part);
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

/** Membership roles the picker may offer — the ladder minus ``owner`` (not
 *  strictly below anyone, ownership moves via ``leave``) and the
 *  non-membership ``full-access``/``guest`` (rankable, never assignable). */
const ASSIGNABLE_ROLES = ['admin', 'editor', 'member', 'reader'] as const;

/** Roles the caller may assign to a given member, mirroring the hub's
 *  ``can_assign`` ceiling: assigned role strictly below the caller's rank AND
 *  the member's current rank strictly below the caller's; never self, never a
 *  row without a resolved rank or user id (the role-change PUT selects the
 *  member by ``user_id``). Empty array = no role-change affordance. */
export function assignableRoles(
  me: ConversationParticipant | null | undefined,
  target: ConversationParticipant | null | undefined,
): string[] {
  const myRank = participantRank(me);
  const targetRank = participantRank(target);
  if (myRank === null || targetRank === null) return [];
  if (!target?.user_id) return [];
  if (me?.user_id === target.user_id) return []; // self-change is hub-banned
  if (targetRank <= myRank) return []; // peers and above are untouchable
  return ASSIGNABLE_ROLES.filter((r) => (roleRank(r) as number) > myRank);
}

/** True when the caller may invite new members: the hub policy grants the
 *  mutating ``members`` action to admin and above (owner via the default
 *  ``owner: *`` policy). */
export function canInviteMembers(me: ConversationParticipant | null | undefined): boolean {
  const rank = participantRank(me);
  return rank !== null && rank <= (roleRank('admin') as number);
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
  return !label || label === 'unknown' ? '?' : initialsFromLabel(label);
}
