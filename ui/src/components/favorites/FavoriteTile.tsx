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
import { Trans, useLingui } from '@lingui/react/macro';
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
import { FAVORITE_DRAG_MIME } from './favorite-dnd';
import { InlineRenameInput } from './InlineRenameInput';
import { useInlineRename } from './use-inline-rename';

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
  /** Allow dragging this tile (into a FolderTile drop target). */
  draggable?: boolean;
  /** Rendered inside a folder popover — adds "Remove from folder" to the menu. */
  inFolder?: boolean;
  /** Move handler from the surface-owning useFavorites instance. WS update ops
   *  don't notify query watchers (only membership changes do), so mutations must
   *  run through the instance that renders the grid for it to refresh live. */
  onMoveToFolder?: (bookmark: Bookmark, folderId: string | null) => void | Promise<void>;
}

/**
 * Desktop-grid tile for a favorited entity. Sized to match MiniDesktop's
 * "+" button (h-16 w-16). Main click navigates; the star overlay in the
 * top-right removes the favorite (hard delete). Right-click opens a context
 * menu with Rename; F2 / double-click also enter rename mode.
 */
export function FavoriteTile({
  bookmark,
  summary,
  draggable = false,
  inFolder = false,
  onMoveToFolder,
}: FavoriteTileProps) {
  const { navigation } = useDockNavigation();
  const { removeFavorite, renameFavorite } = useFavorites();
  const { t } = useLingui();

  const Icon = resolveIcon(bookmark);
  // User-set bookmark.name (from rename) wins over live entity summary.
  const title = bookmark.name || summary?.name || bookmark.displayName;
  const subtitle = summary?.subtitle ?? null;
  const navigable = canNavigateFavorite(bookmark);

  const rename = useInlineRename(title, (next) => renameFavorite(bookmark, next));
  const { editing, startEditing } = rename;

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

  const missingLabel = t`(missing)`;
  const tooltipName = navigable ? title : `${title} ${missingLabel}`;
  const createdAgo = formatTimeAgo(bookmark.created_date);
  const entityType = bookmark.data?.entity_type as string | undefined;

  const tileButton = (
    <button
      type="button"
      onClick={handleClick}
      draggable={draggable && !editing}
      onDragStart={(e) => {
        if (!bookmark.id) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(FAVORITE_DRAG_MIME, bookmark.id);
        e.dataTransfer.setData('text/plain', title);
        // Ghost just the tile, not the Tooltip/ContextMenu wrappers.
        e.dataTransfer.setDragImage(e.currentTarget, 32, 32);
      }}
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
        <InlineRenameInput rename={rename} />
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
              <div className="mt-1 text-[10px] opacity-60"><Trans>Favorited {createdAgo}</Trans></div>
            )}
            <div className="mt-1 border-t border-border/40 pt-1 text-[10px] opacity-60">
              <Trans>Right-click to rename</Trans>
            </div>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setTimeout(startEditing, 0)}><Trans>Rename</Trans></ContextMenuItem>
          {inFolder && onMoveToFolder && (
            <ContextMenuItem onSelect={() => void onMoveToFolder(bookmark, null)}>
              <Trans>Remove from folder</Trans>
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void removeFavorite(bookmark)}>
            <Trans>Remove favorite</Trans>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <button
        type="button"
        onClick={handleRemove}
        aria-label={t`Remove favorite`}
        title={t`Remove favorite`}
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
