import { connectionManager } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import { create } from 'zustand';

/**
 * Webhook types matching backend WebhookType enum
 */
const WebhookType = {
  AGENT_HOOK: 'agent_hook',
  HOOK_OP: 'hook_op',
} as const;

/**
 * Base notification data structure
 */
export interface Notification {
  /** Unique identifier for the notification */
  id: string;
  /** Category of the notification (determines which button shows the badge) */
  category: ViewType;
  /** Human-readable title */
  title: string;
  /** Optional navigation path when clicking the notification */
  navigationPath?: string;
  /** Timestamp when the notification was received */
  timestamp: number;
  /** Additional metadata specific to the notification type */
  metadata?: Record<string, unknown>;
}

/**
 * Skill-specific notification metadata
 */
export interface SkillNotificationMetadata {
  skill_name: string;
  matched_keyword?: string;
  prompt?: string;
  handler_name?: string;
  folder_path?: string;
}

/**
 * Activation rules event types from session events
 */
export type ActivationRulesEventType = 'started_generating_skill' | 'skill_ready';

/**
 * Activation rules event context
 */
export interface ActivationRulesEventContext {
  skill_name?: string;
  session_id?: string;
  cwd?: string;
}

/**
 * Activation rules event metadata
 */
export interface ActivationRulesEventMetadata {
  event_type: ActivationRulesEventType;
  context: ActivationRulesEventContext;
}

/** Notifications grouped by view type using a plain object for proper Zustand reactivity */
type NotificationsByViewType = Partial<Record<ViewType, Notification[]>>;

interface NotificationState {
  /** Pending notifications grouped by view type */
  notifications: NotificationsByViewType;

  /** Add a new notification */
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void;

  /** Clear all notifications for a view type */
  clearCategory: (viewType: ViewType) => void;

  /** Clear a specific notification by id */
  clearNotification: (id: string) => void;

  /** Clear all notifications */
  clearAll: () => void;

  /** Get notifications for a view type */
  getNotifications: (viewType: ViewType) => Notification[];

  /** Get the latest notification for a view type */
  getLatestNotification: (viewType: ViewType) => Notification | null;

  /** Check if a view type has pending notifications */
  hasNotifications: (viewType: ViewType) => boolean;

  /** Get notification count for a view type */
  getNotificationCount: (viewType: ViewType) => number;
}

let notificationIdCounter = 0;

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: {},

  addNotification: (notification) => {
    const id = `notification-${++notificationIdCounter}`;
    const fullNotification: Notification = {
      ...notification,
      id,
      timestamp: Date.now(),
    };

    set((state) => {
      const categoryNotifications = state.notifications[notification.category] || [];

      // Don't add duplicate notifications (same title and navigationPath)
      const exists = categoryNotifications.some(
        (n) => n.title === notification.title && n.navigationPath === notification.navigationPath,
      );
      if (exists) {
        return state;
      }

      return {
        notifications: {
          ...state.notifications,
          [notification.category]: [...categoryNotifications, fullNotification],
        },
      };
    });
  },

  clearCategory: (category) => {
    set((state) => {
      const newNotifications = { ...state.notifications };
      delete newNotifications[category];
      return { notifications: newNotifications };
    });
  },

  clearNotification: (id) => {
    set((state) => {
      const newNotifications = { ...state.notifications };
      for (const viewType of Object.keys(newNotifications) as ViewType[]) {
        const notifications = newNotifications[viewType];
        if (notifications) {
          const filtered = notifications.filter((n) => n.id !== id);
          if (filtered.length !== notifications.length) {
            if (filtered.length === 0) {
              delete newNotifications[viewType];
            } else {
              newNotifications[viewType] = filtered;
            }
            break;
          }
        }
      }
      return { notifications: newNotifications };
    });
  },

  clearAll: () => {
    set({ notifications: {} });
  },

  getNotifications: (category) => {
    return get().notifications[category] || [];
  },

  getLatestNotification: (category) => {
    const notifications = get().notifications[category] || [];
    return notifications.length > 0 ? notifications[notifications.length - 1] : null;
  },

  hasNotifications: (category) => {
    const notifications = get().notifications[category];
    return notifications !== undefined && notifications.length > 0;
  },

  getNotificationCount: (category) => {
    return (get().notifications[category] || []).length;
  },
}));

/**
 * Initialize WebSocket listener for notifications.
 * Handles hook_op events for skill/activation notifications.
 * Should be called once when the app starts.
 */
export function initNotificationListener(): () => void {
  const handleFlowData = (_typeId: unknown, flowData: Record<string, unknown>) => {
    const attributes = flowData.attributes as Record<string, string> | undefined;

    // Handle hook_op events — skill/activation notifications
    if (attributes?.webhook_type === WebhookType.HOOK_OP) {
      const flowValue = flowData.flow_value as Record<string, unknown> | undefined;
      const rsType = flowValue?.type as string | undefined;
      const rsOp = flowValue?.operation as string | undefined;
      const rsData = flowValue?.data as Record<string, unknown> | undefined;
      const eventName = rsData?.event_name as string | undefined;
      const eventData = rsData?.event_data as Record<string, unknown> | undefined;
      const context = eventData?.context as ActivationRulesEventContext | undefined;

      if (rsType === 'skill' && rsOp === 'event' && eventName) {
        if (eventName === 'skill_activated') {
          const notification = (eventData?.notification ?? {}) as SkillNotificationMetadata;
          if (notification.skill_name) {
            useNotificationStore.getState().addNotification({
              category: ViewType.EXECUTE_FLOW,
              title: notification.skill_name,
              navigationPath: notification.folder_path,
              metadata: notification as unknown as Record<string, unknown>,
            });
          }
        } else if (eventName === 'started_generating_skill' && context?.skill_name) {
          useNotificationStore.getState().addNotification({
            category: ViewType.SKILLS,
            title: `Generating: ${context.skill_name}`,
            navigationPath: context.session_id
              ? `/dock/${ViewType.SHELL}/${context.session_id}?resumeClaude=true`
              : undefined,
            metadata: {
              event_type: eventName,
              skill_name: context.skill_name,
              session_id: context.session_id,
              cwd: context.cwd,
            },
          });
        } else if (eventName === 'skill_ready' && context?.skill_name) {
          useNotificationStore.getState().addNotification({
            category: ViewType.EXECUTE_FLOW,
            title: `Ready: ${context.skill_name}`,
            navigationPath: context.cwd
              ? `/dock/${ViewType.EXECUTE_FLOW}/${encodeURIComponent(context.cwd)}`
              : undefined,
            metadata: {
              event_type: eventName,
              skill_name: context.skill_name,
              session_id: context.session_id,
              cwd: context.cwd,
            },
          });
        }
      }
    }

    // Future: Add handlers for other notification types here
    // if (attributes?.webhook_type === 'hook_notification') { ... }
    // if (attributes?.webhook_type === 'trace_notification') { ... }
  };

  connectionManager.on('on_flow_data', handleFlowData);

  return () => {
    connectionManager.off('on_flow_data', handleFlowData);
  };
}
