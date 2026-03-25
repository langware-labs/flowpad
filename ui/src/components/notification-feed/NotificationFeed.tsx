import { Notification, useNotificationStore } from '@src/store/use-notification-store';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { Bell, ExternalLink, Sparkles, X } from 'lucide-react';
import { useCallback } from 'react';

/**
 * Format a timestamp as relative time (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Get display info for a notification based on its metadata
 */
function getNotificationDisplayInfo(notification: Notification): {
  icon: React.ReactNode;
  linkLabel: string;
  status: 'generating' | 'ready' | 'default';
} {
  const metadata = notification.metadata as { event_type?: string } | undefined;
  const eventType = metadata?.event_type;

  if (eventType === 'started_generating_skill') {
    return {
      icon: <Sparkles className="h-4 w-4 animate-pulse text-yellow-500" />,
      linkLabel: 'View Session',
      status: 'generating',
    };
  }

  if (eventType === 'skill_ready') {
    return {
      icon: <Sparkles className="h-4 w-4 text-green-500" />,
      linkLabel: 'Execute Skill',
      status: 'ready',
    };
  }

  return {
    icon: <Bell className="h-4 w-4 text-muted-foreground" />,
    linkLabel: 'View',
    status: 'default',
  };
}

interface NotificationItemProps {
  notification: Notification;
  onNavigate: (notification: Notification) => void;
  onDismiss: (id: string) => void;
}

function NotificationItem({ notification, onNavigate, onDismiss }: NotificationItemProps) {
  const { icon, linkLabel, status } = getNotificationDisplayInfo(notification);

  const statusStyles = {
    generating: 'border-yellow-500/30 bg-yellow-500/5',
    ready: 'border-green-500/30 bg-green-500/5',
    default: 'border-border bg-card/50',
  };

  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-accent/50 ${statusStyles[status]}`}
    >
      <div className="flex-shrink-0">{icon}</div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{notification.title}</span>
        <span className="text-xs text-muted-foreground">{formatRelativeTime(notification.timestamp)}</span>
      </div>

      {notification.navigationPath && (
        <button
          onClick={() => onNavigate(notification)}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10"
        >
          <span>{linkLabel}</span>
          <ExternalLink className="h-3 w-3" />
        </button>
      )}

      <button
        onClick={() => onDismiss(notification.id)}
        className="flex-shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * NotificationFeed - Displays real-time notifications from websocket events
 *
 * Shows skill generation progress, skill ready notifications, and other
 * events received through the data_ops websocket connection.
 */
export function NotificationFeed() {
  const { navigation } = useDockNavigation();
  const { resumeInTerminal } = useResumeInTerminal();
  const notifications = useNotificationStore((state) => state.notifications);
  const clearNotification = useNotificationStore((state) => state.clearNotification);
  const clearAll = useNotificationStore((state) => state.clearAll);

  // Flatten all notifications from all categories and sort by timestamp (newest first)
  const allNotifications = Object.values(notifications)
    .flat()
    .filter((n): n is Notification => n !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp);

  const handleNavigate = useCallback(
    (notification: Notification) => {
      if (!notification.navigationPath) return;

      const metadata = notification.metadata as { event_type?: string; cwd?: string } | undefined;
      const eventType = metadata?.event_type;

      // Route based on event type
      if (eventType === 'started_generating_skill') {
        const claudeSessionId = notification.navigationPath.split('/').pop();
        if (claudeSessionId) {
          resumeInTerminal(claudeSessionId, metadata?.cwd);
        }
        // } else if (eventType === 'skill_ready' && metadata?.cwd) {
        //   // Navigate to execute flow view
        //   navigation.openDock(DockPointer.forExecuteFlow({ vfsAbsPath: metadata.cwd }));
        // } else if (notification.category === ViewType.EXECUTE_FLOW && notification.navigationPath) {
        //   // Generic execute flow navigation
        //   navigation.openDock(DockPointer.forExecuteFlow({ vfsAbsPath: notification.navigationPath }));
      } else {
        // Fallback: open the category tab
        navigation.openTab(notification.category);
      }

      // Clear this notification after navigating
      clearNotification(notification.id);
    },
    [navigation, resumeInTerminal, clearNotification],
  );

  if (allNotifications.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Bell className="h-4 w-4" />
          Notifications
          <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs">{allNotifications.length}</span>
        </h3>
        {allNotifications.length > 1 && (
          <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-foreground">
            Clear all
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {allNotifications.slice(0, 5).map((notification) => (
          <NotificationItem
            key={notification.id}
            notification={notification}
            onNavigate={handleNavigate}
            onDismiss={clearNotification}
          />
        ))}
        {allNotifications.length > 5 && (
          <p className="text-center text-xs text-muted-foreground">+{allNotifications.length - 5} more notifications</p>
        )}
      </div>
    </div>
  );
}
