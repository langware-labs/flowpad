import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { BookmarkType, type Annotation, type Bookmark, type Task } from '@sdk';
import { ArchiveX, MessageSquarePlus, RefreshCw, StickyNote, Tag, X } from 'lucide-react';
import { useRef, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { LearningCard } from './LearningCard';
import { BookmarkCard } from './BookmarkCard';
import { ErrorAlertCard } from './ErrorAlertCard';
import { filterBookmark, BookmarkFilter } from './project-activity-utils';
import { SessionEventsDialog } from './SessionEventsDialog';
import './ProjectActivityStrip.css';

export interface BookmarkColumnProps {
  learningTasks: Task[];
  bookmarks: Bookmark[];
  annotations?: Annotation[];
  errorCount?: number;
  onErrorClick?: () => void;
  onAddComment?: (content: string) => Promise<void>;
  onArchiveLearning?: (task: Task) => void;
  onArchiveAllLearnings?: () => void;
  onCloseBookmark?: (bookmark: Bookmark) => void;
  onDeleteBookmark?: (bookmark: Bookmark) => void;
  onRemindBookmark?: (bookmark: Bookmark, delayMinutes: number) => void;
  onOpenSession?: (bookmark: Bookmark) => void;
  onForkSession?: (bookmark: Bookmark) => void;
  onRefresh?: () => Promise<void>;
  sessionEventCounts?: Map<string, number>;
  snifferEvents?: SnifferEvent[];
}

type BookmarkEntry =
  | { kind: 'learning'; task: Task; timestamp: number }
  | { kind: 'bookmark'; bookmark: Bookmark; timestamp: number }
  | { kind: 'annotation'; annotation: Annotation; timestamp: number };

function AnnotationCard({ annotation }: { annotation: Annotation }) {
  const isComment = annotation.labels?.includes('comment:');
  return (
    <div className="bookmark-card flex flex-col gap-1 rounded border border-border bg-card p-2.5" data-testid="comment-card">
      <div className="flex items-center gap-1.5">
        <Tag className={`h-3.5 w-3.5 ${isComment ? 'text-sky-400' : 'text-lime-400'}`} />
        <span className="text-xs font-medium text-foreground/80">{isComment ? <Trans>Comment</Trans> : <Trans>Prompt</Trans>}</span>
        {annotation.labels?.map(l => (
          <span key={l} className={`rounded px-1 py-0.5 text-[9px] font-mono ${isComment ? 'bg-sky-400/10 text-sky-500' : 'bg-lime-400/10 text-lime-500'}`}>{l}</span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{annotation.content}</p>
    </div>
  );
}

function BookmarksList({
  learningTasks,
  bookmarks,
  annotations,
  filter = BookmarkFilter.Open,
  onArchiveLearning,
  onCloseBookmark,
  onDeleteBookmark,
  onRemindBookmark,
  onOpenSession,
  onForkSession,
  sessionEventCounts,
  sessionLatestEvent,
  onOpenEventDialog,
}: {
  learningTasks: Task[];
  bookmarks: Bookmark[];
  annotations?: Annotation[];
  filter?: BookmarkFilter;
  onArchiveLearning?: (task: Task) => void;
  onCloseBookmark?: (bookmark: Bookmark) => void;
  onDeleteBookmark?: (bookmark: Bookmark) => void;
  onRemindBookmark?: (bookmark: Bookmark) => void;
  onOpenSession?: (bookmark: Bookmark) => void;
  onForkSession?: (bookmark: Bookmark) => void;
  sessionEventCounts?: Map<string, number>;
  sessionLatestEvent?: Map<string, SnifferEvent>;
  onOpenEventDialog?: (sessionId: string, name: string) => void;
}) {
  const entries = useMemo<BookmarkEntry[]>(() => {
    const filteredBookmarks = bookmarks.filter(
      (m) => m.bookmark_type !== BookmarkType.FAVORITE && filterBookmark(m, filter),
    );
    const items: BookmarkEntry[] = [
      ...learningTasks.map((task) => ({
        kind: 'learning' as const,
        task,
        timestamp: new Date(task.created_date || 0).getTime(),
      })),
      ...filteredBookmarks.map((bookmark) => ({
        kind: 'bookmark' as const,
        bookmark,
        timestamp: new Date(bookmark.created_date || 0).getTime(),
      })),
      ...(annotations ?? []).map((annotation) => ({
        kind: 'annotation' as const,
        annotation,
        timestamp: new Date(annotation.iso_timestamp || annotation.created_date || 0).getTime(),
      })),
    ];
    return items.sort((a, b) => b.timestamp - a.timestamp);
  }, [learningTasks, bookmarks, annotations, filter]);

  return (
    <div className="activity-learnings-scroll">
      {entries.map((entry) =>
        entry.kind === 'learning' ? (
          <LearningCard
            key={`learning-${entry.task.id}`}
            task={entry.task}
            onArchive={onArchiveLearning}
            sessionEventCounts={sessionEventCounts}
            sessionLatestEvent={sessionLatestEvent}
            onOpenEventDialog={onOpenEventDialog}
          />
        ) : entry.kind === 'annotation' ? (
          <AnnotationCard key={`annotation-${entry.annotation.id}`} annotation={entry.annotation} />
        ) : (
          <BookmarkCard key={`bookmark-${entry.bookmark.id}`} bookmark={entry.bookmark} onClose={onCloseBookmark} onDelete={onDeleteBookmark} onRemind={onRemindBookmark} onOpenSession={onOpenSession} onForkSession={onForkSession} />
        ),
      )}
    </div>
  );
}

export function BookmarkColumn({
  learningTasks,
  bookmarks,
  annotations,
  errorCount,
  onErrorClick,
  onAddComment,
  onArchiveLearning,
  onArchiveAllLearnings,
  onCloseBookmark,
  onDeleteBookmark,
  onRemindBookmark,
  onOpenSession,
  onForkSession,
  onRefresh,
  sessionEventCounts,
  snifferEvents,
}: BookmarkColumnProps) {
  const { t } = useLingui();
  const [bookmarkFilter, setBookmarkFilter] = useState<BookmarkFilter>(BookmarkFilter.Open);
  const [pendingDeleteBookmark, setPendingDeleteBookmark] = useState<Bookmark | null>(null);
  const [pendingRemindBookmark, setPendingRemindBookmark] = useState<Bookmark | null>(null);
  const [dialogSessionId, setDialogSessionId] = useState<string | null>(null);
  const [dialogSessionName, setDialogSessionName] = useState('');
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  const handleAddComment = async () => {
    if (!commentText.trim() || !onAddComment) return;
    setCommentSaving(true);
    try {
      await onAddComment(commentText.trim());
      setCommentText('');
      setCommentOpen(false);
    } catch {
      // save failed — keep form open so user can retry
    } finally {
      setCommentSaving(false);
    }
  };

  const filteredBookmarkCount = useMemo(
    () => learningTasks.length + bookmarks.filter((m) => filterBookmark(m, bookmarkFilter)).length + (annotations?.length ?? 0),
    [learningTasks, bookmarks, annotations, bookmarkFilter],
  );

  const sessionLatestEvent = useMemo(() => {
    const map = new Map<string, SnifferEvent>();
    if (!snifferEvents) return map;
    for (const evt of snifferEvents) {
      const sid = evt.session_id;
      if (!sid) continue;
      const existing = map.get(sid);
      if (!existing || new Date(evt.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
        map.set(sid, evt);
      }
    }
    return map;
  }, [snifferEvents]);

  const dialogEvents = useMemo(() => {
    if (!dialogSessionId || !snifferEvents) return [];
    return snifferEvents
      .filter((e) => e.session_id === dialogSessionId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [dialogSessionId, snifferEvents]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold"><Trans>Todos</Trans></h3>
          {filteredBookmarkCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {filteredBookmarkCount}
            </span>
          )}
          {onRefresh && (
            <button
              type="button"
              title={t`Refresh — git pull and scan for new notifications`}
              disabled={refreshing}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              onClick={() => {
                setRefreshing(true);
                void onRefresh().finally(() => setRefreshing(false));
              }}
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onArchiveAllLearnings && learningTasks.length > 0 && (
            <button
              type="button"
              title={t`Archive all todos`}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onArchiveAllLearnings}
            >
              <ArchiveX className="h-3.5 w-3.5" />
            </button>
          )}
          {onAddComment && (
            <button
              type="button"
              data-testid="add-comment-button"
              title={t`Add comment`}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setCommentOpen((v) => !v);
                if (!commentOpen) setTimeout(() => commentInputRef.current?.focus(), 50);
              }}
            >
              {commentOpen ? <X className="h-3.5 w-3.5" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Inline comment form */}
      {commentOpen && (
        <div className="border-b border-border p-2.5" data-testid="comment-form">
          <textarea
            ref={commentInputRef}
            data-testid="comment-input"
            rows={2}
            placeholder={t`Add a comment...`}
            className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleAddComment();
            }}
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => { setCommentOpen(false); setCommentText(''); }}
            >
              <Trans>Cancel</Trans>
            </button>
            <button
              type="button"
              data-testid="comment-submit"
              disabled={!commentText.trim() || commentSaving}
              className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
              onClick={() => void handleAddComment()}
            >
              <Trans>Add</Trans>
            </button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="bookmark-filter-bar">
        <select
          className="bookmark-filter-select"
          value={bookmarkFilter}
          onChange={(e) => setBookmarkFilter(e.target.value as BookmarkFilter)}
        >
          <option value="open"><Trans>Open</Trans></option>
          <option value="pending"><Trans>Pending</Trans></option>
          <option value="closed"><Trans>Closed</Trans></option>
          <option value="all"><Trans>All</Trans></option>
        </select>
      </div>

      {/* Error alert */}
      {errorCount != null && errorCount > 0 && onErrorClick && (
        <div className="border-b border-border px-2 py-1.5">
          <ErrorAlertCard count={errorCount} onClick={onErrorClick} />
        </div>
      )}

      {/* Bookmark list */}
      {learningTasks.length === 0 && bookmarks.length === 0 && (!annotations || annotations.length === 0) ? (
        <div className="activity-cell-empty"><Trans>No bookmarks yet</Trans></div>
      ) : (
        <BookmarksList
          learningTasks={learningTasks}
          bookmarks={bookmarks}
          annotations={annotations}
          filter={bookmarkFilter}
          onArchiveLearning={onArchiveLearning}
          onCloseBookmark={onCloseBookmark}
          onDeleteBookmark={(bookmark) => setPendingDeleteBookmark(bookmark)}
          onRemindBookmark={(bookmark) => setPendingRemindBookmark(bookmark)}
          onOpenSession={onOpenSession}
          onForkSession={onForkSession}
          sessionEventCounts={sessionEventCounts}
          sessionLatestEvent={sessionLatestEvent}
          onOpenEventDialog={(sid, name) => {
            setDialogSessionId(sid);
            setDialogSessionName(name);
          }}
        />
      )}

      {/* Event detail dialog */}
      <SessionEventsDialog
        open={!!dialogSessionId}
        onOpenChange={(open) => {
          if (!open) setDialogSessionId(null);
        }}
        sessionName={dialogSessionName}
        events={dialogEvents}
      />

      {/* Bookmark delete confirmation */}
      <ConfirmDialog
        open={!!pendingDeleteBookmark}
        onOpenChange={(open) => !open && setPendingDeleteBookmark(null)}
        title={t`Delete bookmark?`}
        description={`This will permanently delete "${pendingDeleteBookmark?.displayName ?? ''}". This cannot be undone.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          if (pendingDeleteBookmark && onDeleteBookmark) onDeleteBookmark(pendingDeleteBookmark);
          setPendingDeleteBookmark(null);
        }}
      />

      {/* Bookmark snooze TTL picker */}
      <Dialog open={!!pendingRemindBookmark} onOpenChange={(open) => !open && setPendingRemindBookmark(null)}>
        <DialogContent className="max-w-xs p-4">
          <DialogHeader>
            <DialogTitle className="text-sm"><Trans>Snooze bookmark</Trans></DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 pt-1">
            {[
              { label: <Trans>15 minutes</Trans>, minutes: 15 },
              { label: <Trans>1 hour</Trans>, minutes: 60 },
              { label: <Trans>4 hours</Trans>, minutes: 240 },
              { label: <Trans>Tomorrow</Trans>, minutes: 1440 },
            ].map(({ label, minutes }) => (
              <button
                key={minutes}
                type="button"
                className="rounded px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  if (pendingRemindBookmark && onRemindBookmark) onRemindBookmark(pendingRemindBookmark, minutes);
                  setPendingRemindBookmark(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
