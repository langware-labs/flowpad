import { useMemo, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Conversation, TypeId } from '@sdk';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { channelLabel } from '@src/components/conversation/channel-attribution';
import { useEntity } from '@src/hooks/entity-hooks';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { CopyPathButton } from './CopyPathButton';

/**
 * "Which conversation is this" — the card behind a conversation crumb, opened on
 * hover like the project crumb's. Title, where it comes from (channel or native),
 * its project, how many messages and when it started, and who it is with.
 */
export function ConversationCrumbHoverCard({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const { t } = useLingui();
  const typeId = useMemo(() => new TypeId(Conversation.type, conversationId), [conversationId]);
  const conversation = useEntity<Conversation>(typeId).data;
  if (!conversation) return children;

  const channel = channelLabel(conversation.channel) || t`Flowpad`;
  const project = conversation.remote_project_name ?? null;
  const address = (conversation.address ?? []).filter(Boolean);
  const rows: [string, string][] = [
    [t`Channel`, channel],
    ...(project ? ([[t`Project`, project]] as [string, string][]) : []),
    [t`Messages`, String(conversation.message_count ?? 0)],
    ...(conversation.started_at
      ? ([[t`Started`, formatTimeAgoShort(conversation.started_at)]] as [string, string][])
      : []),
    ...(conversation.status ? ([[t`Status`, String(conversation.status)]] as [string, string][]) : []),
  ];

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-80 p-3" data-testid="top-nav-conversation-details">
        <div className="truncate text-sm font-medium text-foreground" title={conversation.displayName}>
          {conversation.displayName}
        </div>
        <div className="mt-2 space-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2 text-xs">
              <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
              <span className="min-w-0 truncate text-foreground">{value}</span>
            </div>
          ))}
        </div>
        {address.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <div className="mb-1 text-[11px] text-muted-foreground">
              <Trans>With</Trans>
            </div>
            {address.map((a) => (
              <CopyPathButton key={a} path={a} testId="top-nav-conversation-address" className="w-full" />
            ))}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
