import { cn } from '@src/lib/utils';
import { Clock, FileText, RefreshCw } from 'lucide-react';
import { useWorkerSessions } from './hooks/use-sessions';

export interface WorkerSessionsPanelProps {
  currentSessionId?: string;
  onSessionClick?: (sessionId: string) => void;
}

const formatTimestamp = (timestamp: string) => {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  } catch {
    return timestamp;
  }
};

interface SessionItemProps {
  sessionId: string;
  title: string;
  timestamp: string;
  isActive?: boolean;
  onClick?: () => void;
}

function SessionItem({ sessionId, title, timestamp, isActive, onClick }: SessionItemProps) {
  const shortId = sessionId.slice(0, 8);

  return (
    <div
      className={cn(
        'cursor-pointer px-3 py-2 hover:bg-accent',
        'flex flex-wrap items-center gap-x-3 gap-y-1 transition-colors',
        isActive && 'bg-accent',
      )}
      onClick={onClick}
    >
      {/* Title - takes available space */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-foreground">{title}</p>
      </div>
      {/* Metadata - stays together on the right */}
      <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          <span>{formatTimestamp(timestamp)}</span>
        </div>
        <code className="rounded bg-muted px-1 py-0.5">{shortId}</code>
      </div>
    </div>
  );
}

export function WorkerSessionsPanel({ currentSessionId, onSessionClick }: WorkerSessionsPanelProps) {
  const { sessions, loading, error, refresh } = useWorkerSessions();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Worker Sessions</span>
          {loading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded p-1 hover:bg-accent disabled:opacity-50"
          title="Refresh sessions"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-3 py-2 text-xs text-destructive">
            <p>{error.message}</p>
          </div>
        )}

        {!error && sessions && sessions.length === 0 && !loading && (
          <div className="flex h-full items-center justify-center px-3 py-8 text-center">
            <p className="text-xs text-muted-foreground">No sessions found for this directory</p>
          </div>
        )}

        {!error && sessions && sessions.length > 0 && (
          <div className="divide-y">
            {/* Session List */}
            {sessions.map((session) => (
              <SessionItem
                key={session.sessionId}
                sessionId={session.sessionId}
                title={session.title}
                timestamp={session.timestamp}
                isActive={session.sessionId === currentSessionId}
                onClick={() => onSessionClick?.(session.sessionId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
