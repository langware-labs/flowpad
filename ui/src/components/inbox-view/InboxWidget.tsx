import { useCallback, useEffect, useState } from 'react';
import { Inbox, RefreshCw } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { useInboxStore } from '@src/store/use-inbox-store';
import { listInboxMessages, fetchInboxFromHub, updateMessage, type InboxMessage } from './inbox-api';

/**
 * Compact inbox summary widget for HomeLanding.
 * Shows unread count badge, recent messages, and a refresh button.
 */
export function InboxWidget() {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const { navigation } = useDockNavigation();
  const { unreadCount, setUnreadCount } = useInboxStore();

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

  const handleMessageClick = useCallback(
    (message: InboxMessage) => {
      void updateMessage(message.id, { is_read: true });
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === message.id ? { ...m, is_read: true } : m));
        setUnreadCount(next.filter((m) => !m.is_read).length);
        return next;
      });
      const taskContext = message.context_entities.find((c) => c.startsWith('task-'));
      if (taskContext) {
        navigation.openDock(DockPointer.forTasks(taskContext.replace(/^task-/, '')));
      }
    },
    [navigation, setUnreadCount],
  );

  const handleOpenInbox = useCallback(() => {
    navigation.openTab(ViewType.INBOX);
  }, [navigation]);

  const preview = messages.slice(0, 4);

  return (
    <div className="rounded-lg border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <button
          className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          onClick={handleOpenInbox}
        >
          <Inbox className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Inbox</span>
          {unreadCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold leading-none text-destructive-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void handleRefresh()}
          disabled={fetching}
          title="Fetch new messages from hub"
        >
          <RefreshCw className={`h-3 w-3 ${fetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Message list */}
      <div className="divide-y">
        {loading && (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">Loading…</div>
        )}
        {!loading && preview.length === 0 && (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">No messages</div>
        )}
        {!loading &&
          preview.map((msg) => (
            <button
              key={msg.id}
              className={`w-full text-left px-3 py-2 hover:bg-accent/50 transition-colors ${
                msg.is_read ? 'opacity-50' : ''
              }`}
              onClick={() => handleMessageClick(msg)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-xs ${msg.is_read ? 'font-normal text-muted-foreground' : 'font-semibold'}`}>
                  {msg.sender_name ?? msg.sender_id ?? 'Unknown'}
                </span>
                {msg.created_date && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {new Date(msg.created_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </div>
              <p className="line-clamp-1 text-[11px] text-muted-foreground">{msg.text}</p>
            </button>
          ))}
      </div>

      {/* Footer: show more link */}
      {messages.length > 4 && (
        <div className="border-t px-3 py-1.5">
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleOpenInbox}
          >
            View all {messages.length} messages
          </button>
        </div>
      )}
    </div>
  );
}
