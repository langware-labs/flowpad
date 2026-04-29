import { Conversation, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import type { RoomTab } from '../RoomTabs';

interface Props {
  projectId: string | null;
  /**
   * When provided (the standard case in CollaborationPage), conversation
   * clicks open as a tab in the room tabs strip — same in-place experience
   * as Skills/Docs. Without it, click is a no-op.
   */
  onOpenTab?: (tab: RoomTab) => void;
}

function deriveTitle(conv: Conversation): string {
  const parts = (conv.participants ?? [])
    .map((p) => (typeof p?.name === 'string' && p.name.trim()) || (typeof p?.email === 'string' && p.email))
    .filter((s): s is string => !!s);
  if (parts.length > 0) return parts.join(', ');
  return 'Conversation';
}

/**
 * Conversations category — lists Conversation entities scoped to the current
 * project. Mirrors the Skills/Plans pattern: each click opens the
 * conversation as a tab via `onOpenTab` so RoomTabs renders the canonical
 * `ConversationPanel`.
 */
export function ConversationsCategory({ projectId, onOpenTab }: Props) {
  const request = useMemo(
    () => new QueryRequest({ type: Conversation.type, name: 'ConversationsCategory' }),
    [],
  );
  const { data: rows = [], isLoading } = useEntitiesQuery<Conversation>(request);

  const items = useMemo(
    () => rows.filter((c) => !!projectId && c.project_id === projectId),
    [rows, projectId],
  );

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }
  if (isLoading && items.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>;
  }
  if (items.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No conversations yet</div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((c) => {
        const title = deriveTitle(c);
        return (
          <li
            key={c.id}
            onClick={() => {
              if (!c.id || !onOpenTab) return;
              onOpenTab({
                key: `conv-${c.id}`,
                type: 'conversation',
                title,
                asset_ref: c.id,
              });
            }}
            title={title}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{title}</span>
          </li>
        );
      })}
    </ul>
  );
}
