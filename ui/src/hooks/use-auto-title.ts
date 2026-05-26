import { useMemo } from 'react';
import { useAuth } from '@sdk/react/hooks';
import type { ConversationParticipant } from '@sdk';
import { formatAutoTitle } from '@src/components/conversation/conversation-title';

/**
 * Slack-style auto-title for a *new* conversation, pinned to the dialog's
 * current open session. The date refreshes when the dialog reopens so a
 * long-lived mount doesn't keep an aging timestamp.
 */
export function useAutoTitle(
  open: boolean,
  participants: ConversationParticipant[],
): string {
  const { cloudUser, user, localUser } = useAuth();
  const myLabel =
    cloudUser?.name ||
    cloudUser?.email ||
    user?.name ||
    user?.email ||
    localUser?.name ||
    'You';
  const openedAt = useMemo(() => new Date(), [open]);
  return useMemo(
    () => (open ? formatAutoTitle(participants, myLabel, openedAt) : ''),
    [open, participants, myLabel, openedAt],
  );
}
