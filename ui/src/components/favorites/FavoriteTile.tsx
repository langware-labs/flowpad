import { Badge } from '@src/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useFavorites } from '@src/hooks/use-favorites';
import type { FavoriteSummary } from '@src/hooks/use-favorite-summaries';
import { cn } from '@src/lib/utils';
import { canNavigateFavorite, navigateToFavorite } from '@src/navigation/favorite-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import type { Bookmark } from '@sdk';
import {
  Bookmark as BookmarkIcon,
  Box,
  FileText,
  FolderKanban,
  GitBranch,
  Hammer,
  Layers,
  MessageSquare,
  Package,
  Star,
  StickyNote,
  Terminal,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const ICON_BY_NAME: Record<string, LucideIcon> = {
  Bookmark: BookmarkIcon,
  Box,
  FileText,
  FolderKanban,
  GitBranch,
  Hammer,
  Layers,
  MessageSquare,
  Package,
  StickyNote,
  Terminal,
  Workflow,
  Zap,
};

const ICON_BY_ENTITY_TYPE: Record<string, LucideIcon> = {
  project: FolderKanban,
  asset: Package,
  skill: Layers,
  agent: Hammer,
  task: MessageSquare,
  workflow: Workflow,
  agentic_process: Terminal,
  claude_session: Terminal,
  collaboration_room: MessageSquare,
  trigger: Zap,
  bookmark: BookmarkIcon,
  plan: FileText,
  command: Terminal,
  claude_hook: Zap,
};

function resolveIcon(bookmark: Bookmark): LucideIcon {
  const explicit = bookmark.data?.icon as string | undefined;
  if (explicit && ICON_BY_NAME[explicit]) return ICON_BY_NAME[explicit];
  const entityType = bookmark.data?.entity_type as string | undefined;
  if (entityType && ICON_BY_ENTITY_TYPE[entityType]) return ICON_BY_ENTITY_TYPE[entityType];
  return BookmarkIcon;
}

interface FavoriteTileProps {
  bookmark: Bookmark;
  /** Live tooltip data from the batch summary endpoint. */
  summary?: FavoriteSummary;
}

/**
 * Desktop-grid tile for a favorited entity. Sized to match MiniDesktop's
 * "+" button (h-16 w-16). Main click navigates; the star overlay in the
 * top-right removes the favorite (hard delete). Right-click opens a context
 * menu with Rename; F2 / double-click also enter rename mode.
 */
export function FavoriteTile({ bookmark, summary }: FavoriteTileProps) {
  const { navigation } = useDockNavigation();
  const { removeFavorite, renameFavorite } = useFavorites();

  const Icon = resolveIcon(bookmark);
  // User-set bookmark.name (from rename) wins over live entity summary.
  const title = bookmark.name || summary?.name || bookmark.displayName;
  const subtitle = summary?.subtitle ?? null;
  const navigable = canNavigateFavorite(bookmark);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(0, inputRef.current.value.length);
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    setDraft(title);
    setEditing(true);
  }, [title]);

  const commitRename = useCallback(async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) return;
    await renameFavorite(bookmark, next);
  }, [draft, title, bookmark, renameFavorite]);

  const handleClick = useCallback(() => {
    if (editing || !navigable) return;
    void navigateToFavorite(bookmark, navigation);
  }, [bookmark, navigation, navigable, editing]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void removeFavorite(bookmark);
    },
    [bookmark, removeFavorite],
  );

  const tooltipName = navigable ? title : `${title} (missing)`;
  const createdAgo = formatTimeAgo(bookmark.created_date);
  const entityType = bookmark.data?.entity_type as string | undefined;

  const tileButton = (
    <button
      type="button"
      onClick={handleClick}
      onDoubleClick={(e) => {
        e.preventDefault();
        startEditing();
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          startEditing();
        }
      }}
      aria-label={tooltipName}
      className={cn(
        'flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        navigable
          ? 'hover:border-primary hover:bg-accent hover:text-foreground cursor-pointer'
          : 'opacity-60 cursor-not-allowed',
      )}
    >
      <Icon className="h-6 w-6" />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitRename()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="w-[58px] rounded border border-border bg-background px-0.5 text-center text-[10px] font-medium leading-none text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      ) : (
        <span className="max-w-[56px] truncate text-[10px] font-medium leading-none">{title}</span>
      )}
    </button>
  );

  return (
    <div className="group relative">
      <ContextMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>{tileButton}</ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="text-xs font-medium">{tooltipName}</div>
            {subtitle && (
              <div className="mt-0.5 line-clamp-3 text-[11px] opacity-80">{subtitle}</div>
            )}
            {(entityType || bookmark.source) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {entityType && (
                  <Badge variant="secondary" className="text-[10px]">
                    {entityType}
                  </Badge>
                )}
                {bookmark.source && (
                  <Badge variant="outline" className="text-[10px]">
                    {bookmark.source}
                  </Badge>
                )}
              </div>
            )}
            {createdAgo && (
              <div className="mt-1 text-[10px] opacity-60">Favorited {createdAgo}</div>
            )}
            <div className="mt-1 border-t border-border/40 pt-1 text-[10px] opacity-60">
              Right-click to rename
            </div>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setTimeout(startEditing, 0)}>Rename</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void removeFavorite(bookmark)}>
            Remove favorite
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <button
        type="button"
        onClick={handleRemove}
        aria-label="Remove favorite"
        title="Remove favorite"
        className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-amber-500 shadow-sm transition-colors hover:bg-amber-500 hover:text-white group-hover:flex focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {navigable ? (
          <Star className="h-3 w-3 fill-current" />
        ) : (
          <X className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}
