import { Badge } from '@src/components/ui/badge';
import type { Bookmark } from '@sdk';
import { BookmarkType } from '@sdk/entities/bookmark';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { Clock, FileText, GitBranch, Play, StickyNote, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { formatTimeAgo } from './project-activity-utils';

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
  const { setPendingTask } = useIncomingTaskStore();
  const { t } = useLingui();
  const isTerminalAnnotation = bookmark.bookmark_type === BookmarkType.TERMINAL_ANNOTATION && !!bookmark.session_id;
  const navPath = bookmark.data?.navigation_path as string | undefined;
  const isClosed = bookmark.status === 'closed';
  const contentPreview = bookmark.content
    ? bookmark.content.length > 120
      ? bookmark.content.slice(0, 120) + '...'
      : bookmark.content
    : null;

  const handleCardClick = () => {
    if (bookmark.bookmark_type === BookmarkType.NOTIFICATION) {
      const taskId = bookmark.data?.task_id as string | undefined;
      if (taskId) {
        setPendingTask({
          taskId,
          taskTitle: bookmark.displayName,
          senderName: (bookmark.data?.sender_name as string | undefined) || 'Someone',
        });
      }
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
      <div
        className={`bookmark-card${navPath || bookmark.bookmark_type === BookmarkType.NOTIFICATION ? 'cursor-pointer' : ''}`}
        onClick={navPath || bookmark.bookmark_type === BookmarkType.NOTIFICATION ? handleCardClick : undefined}
      >
        <div className="bookmark-card-header">
          {isTerminalAnnotation ? (
            <StickyNote className="h-4 w-4 shrink-0 text-yellow-400" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-blue-500" />
          )}
          <span className="bookmark-card-title">{bookmark.displayName}</span>
          <div className="bookmark-card-actions">
            {onRemind && (
              <button
                type="button"
                className="bookmark-card-action-btn"
                title={t`Snooze`}
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
                title={t`Delete bookmark`}
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
                title={t`Close bookmark`}
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
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSession(bookmark);
                }}
              >
                <Play className="h-3 w-3" />
                <Trans>Open Session</Trans>
              </button>
            )}
            {onForkSession && (
              <button
                type="button"
                className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onForkSession(bookmark);
                }}
              >
                <GitBranch className="h-3 w-3" />
                <Trans>Fork Session</Trans>
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
