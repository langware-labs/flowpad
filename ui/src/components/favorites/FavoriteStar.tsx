import { Badge } from '@src/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@src/components/ui/hover-card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useFavorites, type FavoriteRef } from '@src/hooks/use-favorites';
import { cn } from '@src/lib/utils';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Check, Pencil, Star, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface FavoriteStarProps extends FavoriteRef {
  className?: string;
  size?: number;
}

/**
 * Generic star toggle. Drop into any entity row/card:
 *   <FavoriteStar entityType="project" entityId={p.id} title={p.displayName} />
 *
 * Click fills the star and persists a Bookmark(bookmark_type='favorite').
 * Clicking a filled star hard-deletes the bookmark record. When favorited,
 * hovering opens an interactive card with name + inline rename (pencil icon,
 * tab-style edit); right-click also exposes Rename and Remove.
 */
export function FavoriteStar({
  entityType,
  entityId,
  title,
  icon,
  nav,
  className,
  size = 16,
}: FavoriteStarProps) {
  const { isFavorited, toggleFavorite, renameFavorite } = useFavorites();
  const bookmark = isFavorited(entityType, entityId);
  const favorited = !!bookmark;
  const displayName = bookmark?.name || bookmark?.displayName || title;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [cardOpen, setCardOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(displayName);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(0, inputRef.current.value.length);
      }, 0);
    }
  }, [editing, displayName]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      void toggleFavorite({ entityType, entityId, title, icon, nav });
    },
    [toggleFavorite, entityType, entityId, title, icon, nav],
  );

  const startEditing = useCallback(() => {
    setCardOpen(true);
    setEditing(true);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditing(false);
  }, []);

  const commitRename = useCallback(async () => {
    const next = draft.trim();
    const target = bookmark;
    setEditing(false);
    if (!next || !target || next === displayName) return;
    await renameFavorite(target, next);
  }, [draft, bookmark, displayName, renameFavorite]);

  const createdAgo = bookmark?.created_date ? formatTimeAgo(bookmark.created_date) : '';

  const starButton = (
    <button
      type="button"
      aria-label={favorited ? `Favorited: ${displayName}` : 'Add to favorites'}
      onClick={handleClick}
      className={cn(
        'inline-flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:text-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        favorited && 'text-amber-500',
        className,
      )}
    >
      <Star width={size} height={size} className={cn(favorited && 'fill-amber-500')} />
    </button>
  );

  // Unfavorited: keep the original lightweight tooltip — nothing to rename.
  if (!favorited) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{starButton}</TooltipTrigger>
        <TooltipContent side="bottom">Add to favorites</TooltipContent>
      </Tooltip>
    );
  }

  // Favorited: interactive HoverCard with inline rename, plus right-click menu.
  return (
    <ContextMenu>
      <HoverCard
        open={cardOpen || editing}
        onOpenChange={(open) => {
          if (editing) return; // don't auto-close while editing
          setCardOpen(open);
        }}
        openDelay={300}
        closeDelay={120}
      >
        <HoverCardTrigger asChild>
          <ContextMenuTrigger asChild>{starButton}</ContextMenuTrigger>
        </HoverCardTrigger>
        <HoverCardContent side="bottom" align="end" className="w-auto min-w-[14rem] max-w-xs p-2.5">
          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEditing();
                    }
                  }}
                  onBlur={() => void commitRename()}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  title="Save"
                  className="rounded p-0.5 text-emerald-500 hover:bg-muted"
                  onMouseDown={(e) => e.preventDefault()} // keep input focus until click fires
                  onClick={() => void commitRename()}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Cancel"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelEditing}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{displayName}</span>
                <button
                  type="button"
                  title="Rename"
                  aria-label="Rename favorite"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={startEditing}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
          {entityType && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge variant="secondary" className="text-[10px]">
                {entityType}
              </Badge>
            </div>
          )}
          {createdAgo && (
            <div className="mt-1 text-[10px] opacity-60">Favorited {createdAgo}</div>
          )}
          {!editing && (
            <div className="mt-1 border-t border-border/40 pt-1 text-[10px] opacity-60">
              Click the pencil or right-click to rename
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setTimeout(startEditing, 0)}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void toggleFavorite({ entityType, entityId, title, icon, nav })}
        >
          Remove favorite
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
