import { useMemo } from 'react';
import { Conversation, TypeId, isHelpdeskKind } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useMembers } from '@src/hooks/use-members';
import { CategoryChips } from './CategoryChips';
import { SourceChip, useChannelAttribution } from './channel-attribution';
import { conversationFacets } from './conversation-category';

/**
 * A help desk ticket's header chips, beside its title: the desk (staff — the source the ticket
 * arrived through, named after its desk) or "Support" (requester), then the ticket state
 * (waiting / picked / closed). Renders nothing for any other conversation.
 */
export function TicketHeaderChips({
  conv,
  stateOnly = false,
}: {
  conv: Conversation | null;
  /** Only the state chip: for a header that already names the desk (its channel participants). */
  stateOnly?: boolean;
}) {
  const typeId = useMemo(() => (conv?.id ? new TypeId(Conversation.type, conv.id) : null), [conv?.id]);
  const { members } = useMembers(typeId);
  const { cloudUser, currentUser } = useAuth();
  const { attributionForConversation } = useChannelAttribution();
  const deskSource = conv?.channel === 'helpdesk';
  if (!conv || (!isHelpdeskKind(conv.kind) && !deskSource)) return null;
  const attribution = deskSource ? attributionForConversation(conv) : null;
  const facets = conversationFacets({
    conv,
    members,
    viewer: {
      email: (cloudUser?.email || currentUser?.email || '').trim().toLowerCase(),
      cloudUserId: cloudUser?.id ?? null,
      localUserId: currentUser?.id ?? null,
    },
    staffView: deskSource || undefined,
  });
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="conversation-ticket-chips">
      {/* Staff see the desk by name; the requester keeps "Support". The archived chip is a row concern. */}
      {!stateOnly && <SourceChip attribution={attribution} />}
      <CategoryChips
        facets={{ ...facets, isArchived: false, kind: attribution || stateOnly ? 'direct' : facets.kind }}
      />
    </span>
  );
}
