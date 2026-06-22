import { useMemo } from 'react';
import { Bell } from 'lucide-react';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { useBadgeStore } from '../store';
import { NotificationGlyph } from '../NotificationOutlet';
import { NotificationProcessLine } from '../NotificationProcessLine';
import { DiagnoseIconButton } from '../diagnose/DiagnoseIconButton';
import { runAction } from '../commands';
import type { NotificationData } from '../types';

function NotificationItem({ data, onDismiss }: { data: NotificationData; onDismiss: (id: string) => void }) {
  const primary = data.actions?.[0];
  const activate = () => {
    if (!primary) return;
    runAction(primary, data.id);
    onDismiss(data.id);
  };

  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border border-border bg-card/50 px-3 py-2 transition-colors hover:bg-accent/50${primary ? ' cursor-pointer' : ''}`}
      onClick={primary ? activate : undefined}
    >
      <div className="flex-shrink-0">
        <NotificationGlyph data={data} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{data.title}</span>
        <span className="text-xs text-muted-foreground">{formatTimeAgo(new Date(data.timestamp).toISOString()) ?? 'just now'}</span>
        <NotificationProcessLine data={data} />
      </div>
      {primary && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            activate();
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10"
        >
          {primary.label}
        </button>
      )}
      <DiagnoseIconButton
        data={data}
        className="flex-shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(data.id);
        }}
        className="flex-shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Sidebar feed of persistent (`category`-bearing) notifications. Reads the badge
 * store; icon comes from the entity `typeId` or the level glyph, navigation from
 * the notification's primary action.
 */
export function NotificationFeed() {
  const byId = useBadgeStore((s) => s.byId);
  const remove = useBadgeStore((s) => s.remove);
  const clearAll = useBadgeStore((s) => s.clearAll);
  const badges = useMemo(() => Object.values(byId).sort((a, b) => b.timestamp - a.timestamp), [byId]);

  if (badges.length === 0) return null;

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Bell className="h-4 w-4" />
          Notifications
          <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs">{badges.length}</span>
        </h3>
        {badges.length > 1 && (
          <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-foreground">
            Clear all
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {badges.slice(0, 5).map((data) => (
          <NotificationItem key={data.id} data={data} onDismiss={remove} />
        ))}
        {badges.length > 5 && (
          <p className="text-center text-xs text-muted-foreground">+{badges.length - 5} more notifications</p>
        )}
      </div>
    </div>
  );
}
