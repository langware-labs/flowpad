import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useInboxStore } from '@src/store/use-inbox-store';
import {
  listInboxMessages,
  fetchInboxFromHub,
  updateMessage,
  bulkUpdateMessages,
  type InboxMessage,
} from './inbox-api';
import { InboxMessageRow } from './InboxMessageRow';

export function InboxView() {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const { navigation } = useDockNavigation();
  const { setUnreadCount } = useInboxStore();

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const msgs = await listInboxMessages();
      setMessages(msgs);
      setUnreadCount(msgs.filter((m) => !m.is_read).length);
    } finally {
      setLoading(false);
    }
  }, [setUnreadCount]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const handleRefresh = useCallback(async () => {
    setFetching(true);
    try {
      await fetchInboxFromHub();
      await loadMessages();
    } finally {
      setFetching(false);
    }
  }, [loadMessages]);

  const handleArchive = useCallback(async (id: string) => {
    await updateMessage(id, { is_archived: true });
    setMessages((prev) => {
      const next = prev.filter((m) => m.id !== id);
      setUnreadCount(next.filter((m) => !m.is_read).length);
      return next;
    });
  }, [setUnreadCount]);

  const handleToggleRead = useCallback(async (id: string, isRead: boolean) => {
    await updateMessage(id, { is_read: isRead });
    setMessages((prev) => {
      const next = prev.map((m) => (m.id === id ? { ...m, is_read: isRead } : m));
      setUnreadCount(next.filter((m) => !m.is_read).length);
      return next;
    });
  }, [setUnreadCount]);

  const handleMarkAllRead = useCallback(async () => {
    await bulkUpdateMessages({ is_read: true });
    setMessages((prev) => prev.map((m) => ({ ...m, is_read: true })));
    setUnreadCount(0);
  }, [setUnreadCount]);

  const handleMarkAllUnread = useCallback(async () => {
    await bulkUpdateMessages({ is_read: false });
    setMessages((prev) => {
      setUnreadCount(prev.length);
      return prev.map((m) => ({ ...m, is_read: false }));
    });
  }, [setUnreadCount]);

  const handleArchiveAll = useCallback(async () => {
    await bulkUpdateMessages({ is_archived: true });
    setMessages([]);
    setUnreadCount(0);
  }, [setUnreadCount]);

  const handleMessageClick = useCallback(
    (message: InboxMessage) => {
      // Mark as read (fire-and-forget, optimistic update)
      void updateMessage(message.id, { is_read: true });
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === message.id ? { ...m, is_read: true } : m));
        setUnreadCount(next.filter((m) => !m.is_read).length);
        return next;
      });

      // Navigate to task — find first "task-{uuid}" entry in context
      const taskContext = message.context.find((c) => c.startsWith('task-'));
      if (taskContext) {
        const taskId = taskContext.replace(/^task-/, '');
        navigation.openDock(DockPointer.forTasks(taskId));
      }
    },
    [navigation, setUnreadCount],
  );

  const unreadCount = messages.filter((m) => !m.is_read).length;

  return (
    <div className="flex h-full flex-col">
      {/* Header toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Inbox</span>
          {unreadCount > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {unreadCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleMarkAllRead()}
            disabled={loading || messages.length === 0}
          >
            Mark all read
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleMarkAllUnread()}
            disabled={loading || messages.length === 0}
          >
            Mark all unread
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void handleArchiveAll()}
            disabled={loading || messages.length === 0}
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

      {/* Message list */}
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {loading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-sm">No messages</span>
            <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={fetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
              Check for new messages
            </Button>
          </div>
        )}

        {!loading &&
          messages.map((msg) => (
            <InboxMessageRow
              key={msg.id}
              message={msg}
              onArchive={(id) => void handleArchive(id)}
              onToggleRead={(id, isRead) => void handleToggleRead(id, isRead)}
              onClick={handleMessageClick}
            />
          ))}
      </div>
    </div>
  );
}
