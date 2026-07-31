import { useMemo } from 'react';
import { Conversation, FlowMessage, QueryRequest, TypeId, isHelpdeskKind } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';
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
export function HelpdeskMyItems({ limit = 5 }: { limit?: number }) {
  const { navigation } = useDockNavigation();
  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [] } = useEntitiesQuery<Conversation>(request);

  const mine = useMemo(
    () =>
      conversations
        .filter((c) => isHelpdeskKind(c.kind) && !c.archived_at)
        .sort(compareConversationsByRecency)
        .slice(0, limit),
    [conversations, limit],
  );

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
  const last = pointers[pointers.length - 1];
  const latestTypeId = useMemo(
    () => (last?.id ? new TypeId(FlowMessage.type, last.id) : null),
    [last?.id],
  );
  const { data: latest } = useEntity<FlowMessage>(latestTypeId);
  const { cloudUser } = useAuth();

  // "Answered" means the newest message is not the requester's own — the one
  // fact that makes this list worth scanning.
  const answered = !!latest?.sender_id && !!cloudUser?.id && latest.sender_id !== cloudUser.id;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
        data-testid="helpdesk-my-item-row"
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{conv.title || <Trans>Untitled question</Trans>}</span>
          {latest?.message && (
            <span className="block truncate text-xs text-muted-foreground">{latest.message}</span>
          )}
        </span>
        {answered && (
          <span className="shrink-0 rounded-full border border-[hsl(var(--brand))]/40 bg-[hsl(var(--brand))]/10 px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--brand))]">
            <Trans>Replied</Trans>
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground/70">
          {formatTimeAgo(conv.updated_date)}
        </span>
      </button>
    </li>
  );
}
