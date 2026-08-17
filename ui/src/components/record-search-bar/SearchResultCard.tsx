import { SearchResult, getSearchResultBadgeLabel } from '@src/hooks/use-record-search';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { isResultNavigable, navigateToResult, getActionsForResult } from '@src/navigation/record-type-nav';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@src/lib/utils';

const TYPE_COLORS: Record<string, string> = {
  bookmark: 'bg-violet-500/20 text-violet-700 dark:text-violet-300 border-violet-300',
  session: 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-300',
  codex_session: 'bg-green-500/20 text-green-700 dark:text-green-300 border-green-300',
  copilot_session: 'bg-sky-500/20 text-sky-700 dark:text-sky-300 border-sky-300',
  codex_project: 'bg-green-700/20 text-green-800 dark:text-green-200 border-green-300',
  skill: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300',
  agent: 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-300',
  hook: 'bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-300',
  command: 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border-rose-300',
  annotation: 'bg-sky-500/20 text-sky-700 dark:text-sky-300 border-sky-300',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  closed: 'text-muted-foreground',
  archived: 'text-muted-foreground/60',
};

export function SearchResultCard({ result }: { result: SearchResult }) {
  const { navigation } = useDockNavigation();
  const actions = getActionsForResult(result);
  const clickable = isResultNavigable(result);

  const relativeTime = result.modified_at
    ? (() => {
        try {
          return formatDistanceToNow(new Date(result.modified_at), { addSuffix: true });
        } catch {
          return '';
        }
      })()
    : '';

  const title = result.fts_title ?? result.name ?? '(unnamed)';
  const description = result.fts_description;
  // Only show snippet when match is in content (not already visible in title/description)
  const snippetText = result.snippet ? result.snippet.replace(/^(user:|assistant:)\s*/i, '') : null;
  // Suppress snippet if it merely echoes the title (match was in title column)
  const showSnippet = snippetText && !(result.fts_title && snippetText.replace(/<\/?mark>/g, '') === result.fts_title);
  const typeColor = TYPE_COLORS[result.record_type] ?? 'bg-muted text-foreground border-border';
  const typeBadgeLabel = getSearchResultBadgeLabel(result);
  const statusColor = STATUS_COLORS[result.status] ?? 'text-muted-foreground';

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/30',
        clickable && 'cursor-pointer',
      )}
      onClick={clickable ? () => void navigateToResult(result, navigation) : undefined}
    >
      {/* header row: type badge, title, time, message count */}
      <div className="flex items-center gap-2">
        <span className={`rounded border px-1.5 py-0 text-xs font-medium ${typeColor}`}>{typeBadgeLabel}</span>
        <span className="flex-1 truncate text-sm font-semibold">{title}</span>
        {result.message_count != null && result.message_count > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">{result.message_count} msgs</span>
        )}
        {relativeTime && <span className="shrink-0 text-xs text-muted-foreground">{relativeTime}</span>}
      </div>
      {/* description line */}
      {description && <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>}
      {/* snippet — only when match is in content */}
      {showSnippet && (
        <p
          className="line-clamp-3 text-xs text-muted-foreground [&_mark]:rounded [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:text-yellow-900 dark:[&_mark]:bg-yellow-500/30 dark:[&_mark]:text-yellow-200"
          dangerouslySetInnerHTML={{ __html: snippetText }}
        />
      )}
      {/* footer: status dot */}
      {result.status && result.status !== 'new' && (
        <div className="flex items-center gap-1">
          <span className={`text-xs ${statusColor}`}>
            <span className="me-1 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />
            {result.status}
          </span>
        </div>
      )}
      {/* action chips */}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button
              key={a.name}
              type="button"
              onClick={() => {
                if (a.action) {
                  void a.action(result, navigation);
                } else if (a.dockPointer) {
                  navigation.openDock(a.dockPointer(result));
                }
              }}
              className="flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <a.icon className="h-3 w-3" />
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
