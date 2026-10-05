import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, MessagesSquare } from 'lucide-react';

/**
 * The top of a conversation opened on ONE thread (`?thread=<id>`): what the thread is, how big
 * it is, and the way back to every message. Leaving the thread is a NAVIGATION, so this takes a
 * callback and never touches the URL itself — the caller owns the dock, as with `ThreadStack`.
 */
export function ThreadHeader({
  title,
  messageCount,
  onShowAll,
}: {
  title: string;
  /** Authoritative count from `MessageThread.message_count`; null while the row loads. */
  messageCount: number | null;
  onShowAll?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded border border-sky-400/30 bg-sky-500/5 px-2 py-1.5 text-xs"
      data-testid="thread-header"
    >
      <button
        type="button"
        onClick={onShowAll}
        disabled={!onShowAll}
        data-testid="thread-header-all"
        title={t`Back to every message in this conversation`}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
      >
        <ArrowLeft className="h-3 w-3 rtl:-scale-x-100" />
        <Trans>All messages</Trans>
      </button>
      <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-300" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" data-testid="thread-header-title">
        {title || t`Thread`}
      </span>
      {messageCount != null && (
        <span className="shrink-0 text-muted-foreground" data-testid="thread-header-count">
          <Plural value={messageCount} one="# message" other="# messages" />
        </span>
      )}
    </div>
  );
}
