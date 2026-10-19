import { SearchResult, getSearchResultBadgeLabel } from '@src/hooks/use-record-search';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { isResultNavigable, navigateToResult, getActionsForResult } from '@src/navigation/record-type-nav';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { cn } from '@src/lib/utils';
import { TYPE_COLORS } from './RecordSearchBar';

const STATUS_COLORS: Record<string, string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  closed: 'text-muted-foreground',
  archived: 'text-muted-foreground/60',
};

interface SearchResultCardProps {
  result: SearchResult;
  /**
   * `default` — the standalone card of the full-search results list.
   * `inline`  — a denser row inside the home-landing dropdown, where the
   *             parent owns selection and activation.
   */
  variant?: 'default' | 'inline';
  /** inline only: the parent's keyboard/hover cursor is on this row. */
  selected?: boolean;
  /** inline only: activation is the parent's (it also handles Enter). */
  onClick?: () => void;
  onMouseEnter?: () => void;
}

/**
 * One search hit. The full-search list and the home-landing inline dropdown
 * render the same badge / title / time / snippet / action-chip anatomy; only
 * the density and who owns activation differ, hence `variant`.
 */
export function SearchResultCard({
  result,
  variant = 'default',
  selected = false,
  onClick,
  onMouseEnter,
}: SearchResultCardProps) {
  const { navigation } = useDockNavigation();
  const inline = variant === 'inline';
  const actions = getActionsForResult(result);
  const clickable = inline ? true : isResultNavigable(result);

  const relativeTime = formatTimeAgo(result.modified_at) ?? '';
  const title = result.fts_title ?? result.name ?? (inline ? result.record_id : '(unnamed)');
  const description = result.fts_description;
  // Only show snippet when match is in content (not already visible in title/description)
  const snippetText = result.snippet ? result.snippet.replace(/^(user:|assistant:)\s*/i, '') : null;
  // Suppress snippet if it merely echoes the title (match was in title column)
  const showSnippet = snippetText && !(result.fts_title && snippetText.replace(/<\/?mark>/g, '') === result.fts_title);
  const typeColor = TYPE_COLORS[result.record_type] ?? 'bg-muted text-muted-foreground';
  const typeBadgeLabel = getSearchResultBadgeLabel(result);
  const statusColor = STATUS_COLORS[result.status] ?? 'text-muted-foreground';
  // Snippet / description hang under the title, past the badge, in inline mode.
  const indent = inline ? 'ps-[calc(theme(spacing.1)+0.5rem)]' : '';

  return (
    <div
      role={inline ? 'button' : undefined}
      tabIndex={inline ? -1 : undefined}
      className={cn(
        inline
          ? [
              'flex w-full flex-col gap-0.5 px-3 py-2 text-start',
              selected ? 'bg-accent text-foreground' : 'hover:bg-accent/50',
            ]
          : 'flex flex-col gap-1 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/30',
        clickable && 'cursor-pointer',
      )}
      onClick={inline ? onClick : clickable ? () => void navigateToResult(result, navigation) : undefined}
      onMouseEnter={onMouseEnter}
    >
      {/* header row: type badge, title, time, message count */}
      <div className={cn('flex items-center gap-2', inline && 'text-sm')}>
        <span
          className={cn(
            'shrink-0 rounded border px-1.5 py-0 font-medium',
            inline ? 'text-[10px]' : 'text-xs',
            typeColor,
          )}
        >
          {typeBadgeLabel}
        </span>
        <span className={cn('flex-1 truncate font-semibold', !inline && 'text-sm')}>{title}</span>
        {!inline && result.message_count != null && result.message_count > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">{result.message_count} msgs</span>
        )}
        {(relativeTime || inline) && <span className="shrink-0 text-xs text-muted-foreground">{relativeTime}</span>}
      </div>
      {/* description line */}
      {description && !(inline && showSnippet) && (
        <p className={cn('text-xs text-muted-foreground', inline ? 'truncate' : 'line-clamp-2', indent)}>
          {description}
        </p>
      )}
      {/* snippet — only when match is in content */}
      {showSnippet && (
        <p
          className={cn(
            'text-xs text-muted-foreground [&_mark]:rounded [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:text-yellow-900 dark:[&_mark]:bg-yellow-500/30 dark:[&_mark]:text-yellow-200',
            inline ? 'line-clamp-2' : 'line-clamp-3',
            indent,
          )}
          dangerouslySetInnerHTML={{ __html: snippetText }}
        />
      )}
      {/* footer: status dot */}
      {!inline && result.status && result.status !== 'new' && (
        <div className="flex items-center gap-1">
          <span className={`text-xs ${statusColor}`}>
            <span className="me-1 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />
            {result.status}
          </span>
        </div>
      )}
      {/* action chips */}
      {actions.length > 0 && (
        <div className={cn('flex flex-wrap gap-1', inline ? 'pt-0.5' : 'pt-1')} onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button
              key={a.name}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (a.action) {
                  void a.action(result, navigation);
                } else if (a.dockPointer) {
                  navigation.openDock(a.dockPointer(result));
                }
              }}
              className={cn(
                'flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                inline ? 'text-[10px]' : 'text-xs',
              )}
            >
              <a.icon className={inline ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
