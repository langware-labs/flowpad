import { useMemo } from 'react';
import { Conversation, FlowMessage, TypeId, isHelpdeskKind, latestPointer } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks';
import { useRecentConversations } from '@src/hooks/use-recent-conversations';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { conversationFacets } from '@src/components/conversation/conversation-category';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { Trans } from '@lingui/react/macro';
import { MessageSquare } from 'lucide-react';

/**
 * The requester's own tickets, on the portal.
 *
 * Closes a real gap: before this, someone could open a ticket from the portal
 * and then had nowhere in it to see the reply — the answer only surfaced in the
 * global Inbox, which is not where they were looking.
 *
 * Reads local conversations and filters to helpdesk ones. Deliberately NOT the
 * staff queue (`listHelpdeskTickets`), which is a hub call gated on project
 * membership and would 502 for the very requesters this list is for.
 */
/** How many of the requester's questions the portal previews. */
const LIMIT = 5;

/** Hoisted: an inline arrow is a new identity every render and is a dep of the
 *  shared hook's memo, so the filter/sort/slice over every conversation would
 *  re-run on each render of the portal. */
const HELPDESK_ONLY = (c: Conversation) => isHelpdeskKind(c.kind);

export function HelpdeskMyItems() {
  const { navigation } = useDockNavigation();
  // The shared hook owns "recent, not dismissed, not archived" — this only adds
  // the helpdesk narrowing. Re-deriving the query here had already lost the
  // dismissed_at rule, so a ticket dismissed elsewhere reappeared.
  const mine = useRecentConversations(true, { limit: LIMIT, filter: HELPDESK_ONLY });

  if (mine.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" data-testid="helpdesk-my-items">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Trans>Your questions</Trans>
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {mine.map((conv) => (
          <HelpdeskItemRow
            key={conv.id}
            conv={conv}
            onOpen={() => navigation.openDock(DockPointer.forConversation(conv.id))}
          />
        ))}
      </ul>
    </section>
  );
}

function HelpdeskItemRow({ conv, onOpen }: { conv: Conversation; onOpen: () => void }) {
  const pointers = conv.conversationMessageIds ?? [];
  const last = latestPointer(pointers);
  const latestTypeId = useMemo(() => (last?.id ? new TypeId(FlowMessage.type, last.id) : null), [last?.id]);
  const { data: latest } = useEntity<FlowMessage>(latestTypeId);
  const { cloudUser, currentUser } = useAuth();

  // The shared facet, not a local "is the newest message mine?" test. It is
  // viewer-relative and checks BOTH identities — a reply's `sender_id` carries
  // the cloud user id when signed in and the local desktop id otherwise, so a
  // cloud-only comparison misses locally-stamped replies and shows nothing at
  // all to a signed-out requester.
  const facets = conversationFacets({
    conv,
    latestMessage: latest,
    latestPtrTs: last?.ts ?? null,
    viewer: {
      email: (cloudUser?.email || currentUser?.email || '').trim().toLowerCase(),
      cloudUserId: cloudUser?.id ?? null,
      localUserId: currentUser?.id ?? null,
    },
  });

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-accent/50"
        data-testid="helpdesk-my-item-row"
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          {/* The shared rule, not `conv.title` — a ticket opened from this very
              portal carries its label on `name`, which only this helper reads.
              Without it these rows read "Untitled" while the same conversation
              is titled everywhere else in the app. */}
          <span className="block truncate text-sm">{deriveConversationTitle(conv)}</span>
          {latest?.text && <span className="block truncate text-xs text-muted-foreground">{latest.text}</span>}
        </span>
        {facets.isUnread && (
          <span className="shrink-0 rounded-full border border-[hsl(var(--brand))]/40 bg-[hsl(var(--brand))]/10 px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--brand))]">
            <Trans>New reply</Trans>
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground/70">{formatTimeAgo(conv.updated_date)}</span>
      </button>
    </li>
  );
}
