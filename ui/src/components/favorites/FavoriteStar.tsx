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
import { FavoritesEditDialog } from '@src/components/favorites/FavoritesEditDialog';
import { useFavorites, type FavoriteRef } from '@src/hooks/use-favorites';
import { cn } from '@src/lib/utils';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Pencil, Star, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** After a favorite is CREATED, the star morphs to an edit affordance for this
 *  long; a click within the window opens the edit dialog instead of removing.
 *  A product spec — keep it a named constant, don't widen it to mask anything. */
const FAVORITE_EDIT_WINDOW_MS = 5000;

interface FavoriteStarProps extends FavoriteRef {
  className?: string;
  size?: number;
  /**
   * Which HOVER surface the star owns.
   *
   * `'card'` (default) is the historical behaviour: a tooltip when unfavorited,
   * an interactive rename card when favorited.
   *
   * `'none'` gives the hover back to the HOST, for a star whose hover already
   * means something else — the navigation bar's, which opens the bookmarks
   * menu. Both of the default surfaces would otherwise fire first (300ms and
   * instantly, against the menu's 500ms dwell) and sit on top of it. Right-click
   * Rename/Remove is untouched, so nothing becomes unreachable.
   */
  hoverSurface?: 'card' | 'none';
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
  hoverSurface = 'card',
}: FavoriteStarProps) {
  const { t } = useLingui();
  const { isFavorited, toggleFavorite, renameFavorite } = useFavorites();
  const bookmark = isFavorited(entityType, entityId);
  const favorited = !!bookmark;
  const displayName = bookmark?.name || bookmark?.displayName || title;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [cardOpen, setCardOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Post-creation "edit window": for FAVORITE_EDIT_WINDOW_MS after a favorite is
  // created, the star shows an edit glyph and a click opens the edit dialog
  // (pre-selecting the new favorite) instead of un-favoriting.
  const [editWindowActive, setEditWindowActive] = useState(false);
  const [newFavId, setNewFavId] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const editTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEditWindow = useCallback(() => {
    if (editTimerRef.current) {
      clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    setEditWindowActive(false);
  }, []);

  // Open the post-creation edit window on `id` and arm the auto-expiry timer.
  const armEditWindow = useCallback(
    (id: string) => {
      clearEditWindow();
      setNewFavId(id);
      setEditWindowActive(true);
      editTimerRef.current = setTimeout(() => {
        editTimerRef.current = null;
        setEditWindowActive(false);
      }, FAVORITE_EDIT_WINDOW_MS);
    },
    [clearEditWindow],
  );

  useEffect(
    () => () => {
      if (editTimerRef.current) clearTimeout(editTimerRef.current);
    },
    [],
  );

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
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      // In the post-creation edit window, a click opens the edit dialog instead
      // of un-favoriting.
      if (editWindowActive) {
        clearEditWindow();
        setEditDialogOpen(true);
        return;
      }
      // Creating a new favorite → open the 5s edit window on the just-created id.
      if (!favorited) {
        const created = await toggleFavorite({ entityType, entityId, title, icon, nav });
        if (created?.id) armEditWindow(created.id);
        return;
      }
      // Already favorited (no active window) → remove, as before.
      void toggleFavorite({ entityType, entityId, title, icon, nav });
    },
    [editWindowActive, favorited, clearEditWindow, armEditWindow, toggleFavorite, entityType, entityId, title, icon, nav],
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
      aria-label={
        editWindowActive ? t`Edit favorite` : favorited ? t`Favorited: ${displayName}` : t`Add to favorites`
      }
      onClick={(e) => void handleClick(e)}
      className={cn(
        'inline-flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:text-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        favorited && 'text-amber-500',
        className,
      )}
    >
      {editWindowActive ? (
        <Pencil width={size} height={size} />
      ) : (
        <Star width={size} height={size} className={cn(favorited && 'fill-amber-500')} />
      )}
    </button>
  );

  const editDialog = (
    <FavoritesEditDialog
      open={editDialogOpen}
      onOpenChange={setEditDialogOpen}
      selectedFavoriteId={newFavId}
    />
  );

  /** Rename / Remove — and the ONLY route to them once a host takes the hover
   *  (`hoverSurface="none"`), which is why the card below stays mounted. */
  const favoriteContextMenu = (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => setTimeout(startEditing, 0)}><Trans>Rename</Trans></ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void toggleFavorite({ entityType, entityId, title, icon, nav })}>
        <Trans>Remove favorite</Trans>
      </ContextMenuItem>
    </ContextMenuContent>
  );

  // Unfavorited with the host owning hover: a bare button. No tooltip (it would
  // land on top of whatever the host opens), and no context menu — Rename and
  // Remove have no subject until there IS a favorite.
  const content = hoverSurface === 'none' && !favorited ? (
    starButton
  ) : !favorited ? (
    <Tooltip>
      <TooltipTrigger asChild>{starButton}</TooltipTrigger>
      <TooltipContent side="bottom"><Trans>Add to favorites</Trans></TooltipContent>
    </Tooltip>
  ) : (
    <ContextMenu>
      {/* The card is MOUNTED in both modes, because it hosts the rename input
          that right-click Rename opens (`startEditing` sets `editing`). When the
          host owns the hover it is driven by `editing` alone — hover never opens
          it, but Rename still does. Removing the card outright would leave
          Rename firing state nothing renders. */}
      <HoverCard
        open={hoverSurface === 'none' ? editing : cardOpen || editing}
        onOpenChange={(open) => {
          if (editing) return; // don't auto-close while editing
          if (hoverSurface === 'none') return; // hover is the host's
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
                  title={t`Save`}
                  className="rounded p-0.5 text-emerald-500 hover:bg-muted"
                  onMouseDown={(e) => e.preventDefault()} // keep input focus until click fires
                  onClick={() => void commitRename()}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={t`Cancel`}
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
                  title={t`Rename`}
                  aria-label={t`Rename favorite`}
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
            <div className="mt-1 text-[10px] opacity-60"><Trans>Favorited {createdAgo}</Trans></div>
          )}
          {!editing && (
            <div className="mt-1 border-t border-border/40 pt-1 text-[10px] opacity-60">
              <Trans>Click the pencil or right-click to rename</Trans>
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
      {favoriteContextMenu}
    </ContextMenu>
  );

  return (
    <>
      {content}
      {editDialogOpen && editDialog}
    </>
  );
}
