import { Conversation, isHelpdeskKind } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { CategoryChips } from './CategoryChips';
import { SourceChip, useChannelAttribution } from './channel-attribution';
import { conversationFacets, isDeskTicket } from './conversation-category';

/**
 * A help desk ticket's header chip, beside its title: the desk (staff — the source the ticket
 * arrived through, named after its desk) or "Support" (requester). The ticket's STATE is not here:
 * the status button in the conversation says it, and the StreamInbox row wears it as a chip.
 * Renders nothing for any other conversation.
 */
export function TicketHeaderChips({ conv }: { conv: Conversation | null }) {
  const { cloudUser, currentUser, currentPrincipal } = useAuth();
  const { attributionForConversation } = useChannelAttribution();
  const deskSource = isDeskTicket(conv);
  if (!conv || (!isHelpdeskKind(conv.kind) && !deskSource)) return null;
  const attribution = deskSource ? attributionForConversation(conv) : null;
  const facets = conversationFacets({
    conv,
    viewer: {
      email: (cloudUser?.email || currentUser?.email || '').trim().toLowerCase(),
      cloudUserId: cloudUser?.id ?? null,
      localUserId: currentPrincipal?.id ?? null,
    },
    staffView: deskSource || undefined,
  });
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="conversation-ticket-chips">
      {/* Staff see the desk by name; the requester keeps "Support". The archived chip is a row concern. */}
      <SourceChip attribution={attribution} />
      <CategoryChips
        facets={{ ...facets, isArchived: false, ticket: undefined, kind: attribution ? 'direct' : facets.kind }}
      />
    </span>
  );
}
