import type { Conversation } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { SourceChip, channelLabel, useChannelAttribution } from './channel-attribution';

/**
 * Who a CHANNEL conversation is with — in the place a Flowpad conversation shows its members and Invite. A channel's
 * people are on that channel (a phone, a chat id, an address), not on the Flowpad roster, so there is nobody to invite
 * and nothing to manage here: the channel's mark and the addresses it talks to, read-only.
 */
export function ChannelParticipants({ conversation }: { conversation: Conversation }) {
  const { t } = useLingui();
  const { attributionForConversation } = useChannelAttribution();
  const attribution = attributionForConversation(conversation);
  const label = attribution?.label || channelLabel(conversation.channel);
  const addresses = conversation.address ?? [];
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="channel-participants"
      title={t`This conversation is on ${label}: the people in it are on ${label}, not Flowpad members.`}
    >
      <SourceChip attribution={attribution} />
      {addresses.length > 0 && <span className="truncate font-mono">{addresses.join(', ')}</span>}
    </span>
  );
}
