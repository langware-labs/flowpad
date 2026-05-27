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
