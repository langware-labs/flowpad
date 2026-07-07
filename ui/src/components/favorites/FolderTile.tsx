import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useFavorites } from '@src/hooks/use-favorites';
import {
  summaryForBookmark,
  type FavoriteSummary,
} from '@src/hooks/use-favorite-summaries';
import { cn } from '@src/lib/utils';
import type { Bookmark } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Folder } from 'lucide-react';
import { useState } from 'react';
import { FavoriteTile } from './FavoriteTile';
import { favoriteDragActive, readFavoriteDragId } from './favorite-dnd';
import { InlineRenameInput } from './InlineRenameInput';
import { useInlineRename } from './use-inline-rename';

interface FolderTileProps {
  folder: Bookmark;
  /** The folder's member favorites (useFavorites().childrenOf(folder.id)). */
  childFavorites: Bookmark[];
  /** All favorites (drop payloads carry only the bookmark id). */
  favorites: Bookmark[];
  /** MiniDesktop's batch summary map — children resolve their tooltips from it. */
  summaries: Map<string, FavoriteSummary>;
  /** Move handler from the surface-owning useFavorites instance (see
   *  FavoriteTile.onMoveToFolder for why it must not be a local instance). */
  onMoveToFolder: (bookmark: Bookmark, folderId: string | null) => void | Promise<void>;
}

/**
 * Desktop-grid tile for a favorite folder (bookmark_type='favorite_folder').
 * Same 64px tile grammar as FavoriteTile. Click opens a popover with the
 * member tiles; dropping a dragged favorite on the tile files it here.
 * Right-click: Rename (inline, like FavoriteTile) and Delete folder — deletion
 * promotes members back to root (server-side), never deletes them.
 */
export function FolderTile({ folder, childFavorites, favorites, summaries, onMoveToFolder }: FolderTileProps) {
  const { renameFavorite, deleteFolder } = useFavorites();

  const title = folder.name || folder.title || folder.displayName;
  const [dragOver, setDragOver] = useState(false);

  const rename = useInlineRename(title, (next) => renameFavorite(folder, next));
  const { editing, startEditing } = rename;

  const handleDragOver = (e: React.DragEvent) => {
    if (!favoriteDragActive(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    setDragOver(false);
    const id = readFavoriteDragId(e);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    // Resolve among favorites only — a folder id can never match (one level).
    const dragged = favorites.find((b) => b.id === id);
    if (!dragged || dragged.parent_id === folder.id) return;
    void onMoveToFolder(dragged, folder.id ?? null);
  };

  const tileButton = (
    <button
      type="button"
      onClick={(e) => {
        // PopoverTrigger's own (composed) click handler does the toggling;
        // preventDefault suppresses it while the inline rename is active.
        if (editing) e.preventDefault();
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label={title}
      data-testid="favorite-folder-tile"
      className={cn(
        'relative flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        dragOver && 'border-primary bg-primary/10 ring-1 ring-primary/40',
      )}
    >
      <span className="relative">
        <Folder className="h-6 w-6" />
        {childFavorites.length > 0 && (
          <span className="absolute -right-2 -top-1.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-[13px] text-primary-foreground">
            {childFavorites.length}
          </span>
        )}
      </span>
      {editing ? (
        <InlineRenameInput rename={rename} />
      ) : (
        <span className="max-w-[56px] truncate text-[10px] font-medium leading-none">{title}</span>
      )}
    </button>
  );

  return (
    <Popover>
      <ContextMenu>
        <PopoverTrigger asChild>
          <ContextMenuTrigger asChild>{tileButton}</ContextMenuTrigger>
        </PopoverTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setTimeout(startEditing, 0)}>
            <Trans>Rename</Trans>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void deleteFolder(folder)}>
            <Trans>Delete folder</Trans>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent
        align="start"
        className="w-auto max-w-[19rem] p-3"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {childFavorites.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            <Trans>Drop favorites here</Trans>
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {childFavorites.map((b) => (
              <FavoriteTile
                key={b.id}
                bookmark={b}
                summary={summaryForBookmark(b, summaries)}
                inFolder
                draggable
                onMoveToFolder={onMoveToFolder}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
