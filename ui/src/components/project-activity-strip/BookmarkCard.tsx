import { useState } from 'react';
import { Badge } from '@src/components/ui/badge';
import type { Bookmark } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { openTaskNotification } from '@sdk/entities/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { Clock, FileText, GitBranch, Play, StickyNote, X } from 'lucide-react';

function formatTimeAgo(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function BookmarkCard({
  bookmark,
  onClose,
  onDelete,
  onRemind,
  onOpenSession,
  onForkSession,
}: {
  bookmark: Bookmark;
  onClose?: (bookmark: Bookmark) => void;
  onDelete?: (bookmark: Bookmark) => void;
  onRemind?: (bookmark: Bookmark) => void;
  onOpenSession?: (bookmark: Bookmark) => void;
  onForkSession?: (bookmark: Bookmark) => void;
}) {
  const { navigation } = useDockNavigation();
  const [gitError, setGitError] = useState<string | null>(null);
  const isTerminalAnnotation = bookmark.bookmark_type === 'terminal_annotation' && !!bookmark.session_id;
  const navPath = bookmark.data?.navigation_path as string | undefined;
  const isClosed = bookmark.status === 'closed';
  const contentPreview = bookmark.content
    ? bookmark.content.length > 120
      ? bookmark.content.slice(0, 120) + '...'
      : bookmark.content
    : null;

  const handleCardClick = () => {
    if (bookmark.bookmark_type === 'cross_notification') {
      const projectUrl = bookmark.data?.project_url as string | undefined;
      const taskId = bookmark.data?.task_id as string | undefined;
      void openTaskNotification(projectUrl ?? '', taskId ?? '')
        .then(({ navigation_path, git_error }) => {
          if (git_error) {
            setGitError(git_error);
            return;
          }
          const match = navigation_path.match(/^\/dock\/([^/]+)\/(.+)$/);
          if (match) navigation.openDock(DockPointer.fromUrl(match[1], match[2]));
        })
        .catch((err: unknown) => {
          const msg = (err as any)?.response?.data?.message
            || (err instanceof Error ? err.message : 'Failed to open task.');
          setGitError(msg);
        });
      return;
    }
    if (!navPath) return;
    const match = navPath.match(/^\/dock\/([^/]+)\/(.+)$/);
    if (match) {
      try {
        navigation.openDock(DockPointer.fromUrl(match[1], match[2]));
      } catch {
        // ignore navigation errors
      }
    }
  };

  return (
    <>
    <AlertDialog open={!!gitError} onOpenChange={(o) => { if (!o) setGitError(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Git Pull Failed</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p className="mb-2">The task could not be pulled from the remote repository. The task may not be up to date.</p>
              <pre className="max-h-40 overflow-auto rounded bg-muted px-3 py-2 text-xs text-foreground whitespace-pre-wrap">{gitError}</pre>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <div
      className={`bookmark-card${navPath || bookmark.bookmark_type === 'cross_notification' ? ' cursor-pointer' : ''}`}
      onClick={navPath || bookmark.bookmark_type === 'cross_notification' ? handleCardClick : undefined}
    >
      <div className="bookmark-card-header">
        {isTerminalAnnotation
          ? <StickyNote className="h-4 w-4 shrink-0 text-yellow-400" />
          : <FileText className="h-4 w-4 shrink-0 text-blue-500" />
        }
        <span className="bookmark-card-title">{bookmark.title || 'Untitled bookmark'}</span>
        <div className="bookmark-card-actions">
          {onRemind && (
            <button
              type="button"
              className="bookmark-card-action-btn"
              title="Snooze"
              onClick={(e) => {
                e.stopPropagation();
                onRemind(bookmark);
              }}
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
          )}
          {isClosed && onDelete && (
            <button
              type="button"
              className="bookmark-card-action-btn bookmark-card-action-btn--close"
              title="Delete bookmark"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(bookmark);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {!isClosed && onClose && (
            <button
              type="button"
              className="bookmark-card-action-btn bookmark-card-action-btn--close"
              title="Close bookmark"
              onClick={(e) => {
                e.stopPropagation();
                onClose(bookmark);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <span className="bookmark-card-time">{formatTimeAgo(bookmark.created_date)}</span>
      </div>
      {contentPreview && <p className="bookmark-card-content">{contentPreview}</p>}
      {isTerminalAnnotation && (onOpenSession || onForkSession) && (
        <div className="flex gap-1.5 pt-1">
          {onOpenSession && (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-accent"
              onClick={(e) => { e.stopPropagation(); onOpenSession(bookmark); }}
            >
              <Play className="h-3 w-3" />
              Open Session
            </button>
          )}
          {onForkSession && (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); onForkSession(bookmark); }}
            >
              <GitBranch className="h-3 w-3" />
              Fork Session
            </button>
          )}
        </div>
      )}
      <div className="bookmark-card-badges">
        {bookmark.bookmark_type && !isTerminalAnnotation && (
          <Badge variant="secondary" className="text-[10px]">
            {bookmark.bookmark_type}
          </Badge>
        )}
        {bookmark.source && (
          <Badge variant="outline" className="text-[10px]">
            {bookmark.source}
          </Badge>
        )}
      </div>
    </div>
    </>
  );
}
