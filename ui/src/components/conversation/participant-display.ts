import type { ConversationParticipant } from '@sdk';

export function participantLabel(participant: ConversationParticipant | null | undefined): string {
  return participant?.name?.trim() || participant?.email?.trim() || 'unknown';
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

/** First-letter initials for the avatar fallback. Strips non-letters and
 *  caps at two characters. Falls back to "?" so the avatar never goes blank. */
export function participantInitials(participant: ConversationParticipant | null | undefined): string {
  const label = participantLabel(participant);
  if (!label || label === 'unknown') return '?';
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return label.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
