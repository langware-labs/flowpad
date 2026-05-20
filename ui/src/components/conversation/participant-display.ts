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
