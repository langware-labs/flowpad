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
  favoriteSummaryKey,
  type FavoriteSummary,
} from '@src/hooks/use-favorite-summaries';
import { cn } from '@src/lib/utils';
import type { Bookmark } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Folder } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FavoriteTile } from './FavoriteTile';
import { favoriteDragActive, readFavoriteDragId } from './favorite-dnd';

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
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

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
    await renameFavorite(folder, next);
  }, [draft, title, folder, renameFavorite]);

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

  const summaryFor = (b: Bookmark): FavoriteSummary | undefined => {
    const type = b.data?.entity_type;
    const id = b.data?.entity_id;
    return typeof type === 'string' && typeof id === 'string'
      ? summaries.get(favoriteSummaryKey(type, id))
      : undefined;
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
    <Popover open={open} onOpenChange={setOpen}>
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
                summary={summaryFor(b)}
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
