import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CheckSquare, RefreshCw } from 'lucide-react';
import { Conversation, FlowMessage, QueryRequest, Task, TypeId } from '@sdk';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { resolveConversationDockPointer } from '@src/navigation/conversation-route-resolver';
import { useInboxStore } from '@src/store/use-inbox-store';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import {
  fetchInboxFromHub,
  updateMessage,
  bulkUpdateMessages,
} from './inbox-api';

// ── Time formatter (Gmail-style) ────────────────────────────────────────────
// today → "12:34 PM"  ·  this year → "Apr 28"  ·  older → locale date
function formatGmailTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString();
}

// ── Conversation list row (Gmail thread row) ────────────────────────────────
// Single line: [sender(s)] [subject — snippet…] [time]
// Click anywhere on the row opens the conversation via its dockPointer.

interface ConversationListRowProps {
  conv: Conversation;
  isFocused: boolean;
  onArchive: (messageId: string) => void;
  onToggleRead: (messageId: string, isRead: boolean) => void;
  refSetter: (el: HTMLDivElement | null) => void;
}

function ConversationListRow({ conv, isFocused, onArchive, onToggleRead, refSetter }: ConversationListRowProps) {
  const { navigation } = useDockNavigation();
  const taskTypeId = useMemo(
    () => (conv.task_id ? new TypeId(Task.type, conv.task_id) : null),
    [conv.task_id],
  );
  const { data: task } = useEntity<Task>(taskTypeId);

  // Fetch only the latest FlowMessage for sender + snippet + read state.
  const pointers = conv.conversationMessageIds ?? [];
  const latest = pointers[pointers.length - 1];
  const latestTypeId = useMemo(
    () => (latest?.message_id ? new TypeId(FlowMessage.type, latest.message_id) : null),
    [latest?.message_id],
  );
  const { data: latestMessage } = useEntity<FlowMessage>(latestTypeId);

  // Hide archived rows: "Archive all" flips is_archived on every FlowMessage,
  // so when the latest message is archived we treat the conversation as
  // archived too. Without this the row keeps rendering and looks unchanged.
  if (latestMessage?.is_archived) return null;
  // Hide rows whose latest FlowMessage couldn't be loaded — usually means the
  // bundle hasn't been pulled yet (we'd just render an empty "Unknown" row
  // and 404 in the network tab). The auto inbox-fetch on mount will pull the
  // bundle and the row will materialise on the next entity update.
  if (latest && !latestMessage) return null;

  const sender = latestMessage?.sender_name?.trim() || 'Unknown';
  const count = pointers.length;
  const subject = task?.title?.trim() || 'Conversation';
  const snippet = latestMessage?.text?.replace(/\s+/g, ' ').trim() ?? '';
  const time = formatGmailTime(conv.updated_date);
  const ago = formatTimeAgo(conv.updated_date);
  const isUnread = latestMessage ? !latestMessage.is_read : false;

  const handleClick = () => {
    if (!conv.id) return;
    navigation.openDock(
      resolveConversationDockPointer({
        conversationId: conv.id,
        taskId: conv.task_id ?? null,
        projectId: conv.project_id ?? null,
      }),
    );
  };

  return (
    <div
      ref={refSetter}
      data-testid="inbox-conversation-row"
      data-conversation-id={conv.id ?? ''}
      data-focused={isFocused ? 'true' : 'false'}
      data-unread={isUnread ? 'true' : 'false'}
      onClick={handleClick}
      className={`group relative flex h-9 cursor-pointer items-center gap-3 border-b border-border/40 px-3 text-sm transition-colors hover:bg-accent/40 hover:shadow-sm ${
        isFocused ? 'bg-primary/10' : ''
      } ${isUnread ? 'bg-background' : 'bg-muted/20'}`}
    >
      <span
        data-testid="inbox-row-sender"
        className={`w-44 shrink-0 truncate ${isUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
      >
        {sender}
        {count > 1 && <span className="ml-1 font-normal text-muted-foreground">({count})</span>}
      </span>
      <span className="min-w-0 flex-1 truncate" data-testid="inbox-row-subject-line">
        <span className={isUnread ? 'font-semibold text-foreground' : 'text-foreground/80'}>{subject}</span>
        {snippet && (
          <>
            <span className="mx-1 text-muted-foreground">—</span>
            <span className="text-muted-foreground">{snippet}</span>
          </>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground transition-opacity group-hover:opacity-0">
        {time}
        {ago && <span className="ml-1.5 text-muted-foreground/70">· {ago}</span>}
      </span>
      <div
        className="absolute right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="rounded p-1 hover:bg-muted"
          title={isUnread ? 'Mark read' : 'Mark unread'}
          onClick={() => latestMessage?.id && onToggleRead(latestMessage.id, isUnread)}
        >
          <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        <button
          className="rounded p-1 hover:bg-destructive/10"
          title="Archive"
          onClick={() => latestMessage?.id && onArchive(latestMessage.id)}
        >
          <Archive className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      </div>
    </div>
  );
}

// ── InboxView ───────────────────────────────────────────────────────────────

export function InboxView() {
  const [fetching, setFetching] = useState(false);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const { navigation, currentDock } = useDockNavigation();
  const { setUnreadCount } = useInboxStore();

  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [], refetch, isLoading } = useEntitiesQuery<Conversation>(request);

  const sorted = useMemo(() => {
    const list = [...conversations];
    list.sort((a, b) => {
      const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
      const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
      return tb - ta;
    });
    return list;
  }, [conversations]);

  // Keep the unread badge in sync AND compute the visible-conversation count
  // from the same source (`listInboxMessages` already filters out archived
  // FlowMessages server-side). The header count needs to reflect what the
  // user actually sees: after "Archive all" the conversation entities still
  // exist locally but every row hides itself, so we can't use sorted.length.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { listInboxMessages } = await import('./inbox-api');
        const msgs = await listInboxMessages();
        if (cancelled) return;
        setUnreadCount(msgs.filter((m) => !m.is_read).length);
        const visibleConvs = new Set(
          msgs.map((m) => m.conversation_id).filter((id): id is string => !!id),
        );
        setVisibleCount(visibleConvs.size);
      } catch {
        // non-fatal — leave visibleCount as-is.
      }
    })();
    return () => { cancelled = true; };
  }, [setUnreadCount, conversations.length]);

  // On inbox mount: pull any pending bundles from the hub so conversations
  // whose pointer-list references not-yet-materialised FlowMessages don't
  // 404 in the rendered rows. Fire-and-forget — the entity-update channel
  // will refresh rows once the FMs land locally.
  useEffect(() => {
    void fetchInboxFromHub().then(() => refetch()).catch(() => {});
    // Run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const handleRefresh = useCallback(async () => {
    setFetching(true);
    try {
      await fetchInboxFromHub();
      void refetch();
    } finally {
      setFetching(false);
    }
  }, [refetch]);

  const handleArchive = useCallback(async (id: string) => {
    await updateMessage(id, { is_archived: true });
    void refetch();
  }, [refetch]);

  const handleToggleRead = useCallback(async (id: string, isRead: boolean) => {
    await updateMessage(id, { is_read: isRead });
    void refetch();
  }, [refetch]);

  const handleMarkAllRead = useCallback(async () => {
    await bulkUpdateMessages({ is_read: true });
    setUnreadCount(0);
    void refetch();
  }, [refetch, setUnreadCount]);

  const handleArchiveAll = useCallback(async () => {
    await bulkUpdateMessages({ is_archived: true });
    setUnreadCount(0);
    void refetch();
  }, [refetch, setUnreadCount]);


  // List mode
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Inbox</span>
          {visibleCount !== null && visibleCount > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {visibleCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleMarkAllRead()}
            disabled={isLoading || (visibleCount ?? 0) === 0}
          >
            Mark all read
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void handleArchiveAll()}
            disabled={isLoading || (visibleCount ?? 0) === 0}
          >
            Archive all
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleRefresh()}
            disabled={fetching}
            title="Fetch new messages from hub"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        )}

        {!isLoading && (visibleCount ?? sorted.length) === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-sm">No conversations</span>
            <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={fetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
              Check for new messages
            </Button>
          </div>
        )}

        {!isLoading &&
          sorted.map((conv) => (
            <ConversationListRow
              key={conv.id ?? ''}
              conv={conv}
              isFocused={false}
              onArchive={handleArchive}
              onToggleRead={handleToggleRead}
              refSetter={(el) => {
                if (conv.id) rowRefs.current.set(conv.id, el);
              }}
            />
          ))}
      </div>
    </div>
  );
}
