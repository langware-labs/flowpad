import type { Bookmark } from '@sdk';
import type { FavoriteSummary } from '@src/hooks/use-favorite-summaries';
import { useFavorites } from '@src/hooks/use-favorites';
import { cn } from '@src/lib/utils';
import { canNavigateFavorite, navigateToFavorite } from '@src/navigation/favorite-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
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
import { useCallback } from 'react';

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
 * top-right removes the favorite (hard delete).
 */
export function FavoriteTile({ bookmark, summary }: FavoriteTileProps) {
  const { navigation } = useDockNavigation();
  const { removeFavorite } = useFavorites();

  const Icon = resolveIcon(bookmark);
  const title = summary?.name || bookmark.displayName;
  const subtitle = summary?.subtitle ?? null;
  const navigable = canNavigateFavorite(bookmark);

  const handleClick = useCallback(() => {
    if (!navigable) return;
    void navigateToFavorite(bookmark, navigation);
  }, [bookmark, navigation, navigable]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void removeFavorite(bookmark);
    },
    [bookmark, removeFavorite],
  );

  const tooltipName = navigable ? title : `${title} (missing)`;

  return (
    <div className="group relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            aria-label={tooltipName}
            className={cn(
              'flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              navigable
                ? 'hover:border-primary hover:bg-accent hover:text-foreground cursor-pointer'
                : 'opacity-60 cursor-not-allowed',
            )}
          >
            <Icon className="h-6 w-6" />
            <span className="max-w-[56px] truncate text-[10px] font-medium leading-none">
              {title}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="text-xs font-medium">{tooltipName}</div>
          {subtitle && (
            <div className="mt-0.5 line-clamp-3 text-[11px] opacity-80">
              {subtitle}
            </div>
          )}
        </TooltipContent>
      </Tooltip>

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
