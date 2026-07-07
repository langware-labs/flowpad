import { FavoriteTile } from '@src/components/favorites/FavoriteTile';
import { FolderTile } from '@src/components/favorites/FolderTile';
import { useFavorites } from '@src/hooks/use-favorites';
import {
  summaryForBookmark,
  useFavoriteSummaries,
} from '@src/hooks/use-favorite-summaries';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { QuickCreateDialog } from './QuickCreateDialog';
import { QuickCreateModal } from './QuickCreateModal';

/**
 * MiniDesktop — a desktop-grid surface on the home landing. The "+" button is
 * always first; each favorited entity renders as a tile beside it. Clicking it
 * opens the desktop-style QuickCreateModal launcher.
 */
export function MiniDesktop() {
  const { t } = useLingui();
  const [modalOpen, setModalOpen] = useState(false);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Summaries stay keyed off ALL favorites (not just root) so folder children
  // resolve their tooltips inside the FolderTile popover.
  const { favorites, folders, rootFavorites, childrenOf, moveToFolder } = useFavorites();
  const summaries = useFavoriteSummaries(favorites);

  const handlePick = (type: string) => {
    setActiveType(type);
    setDialogOpen(true);
  };

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        aria-label={t`Quick create`}
        title={t`Create new…`}
        className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="h-6 w-6" />
        <span className="text-[10px] font-medium leading-none"><Trans>New</Trans></span>
      </button>

      <QuickCreateModal open={modalOpen} onOpenChange={setModalOpen} onPick={handlePick} />

      {folders.map((folder) => (
        <FolderTile
          key={folder.id}
          folder={folder}
          childFavorites={folder.id ? childrenOf(folder.id) : []}
          favorites={favorites}
          summaries={summaries}
          onMoveToFolder={moveToFolder}
        />
      ))}

      {rootFavorites.map((fav) => (
        <FavoriteTile key={fav.id} bookmark={fav} summary={summaryForBookmark(fav, summaries)} draggable />
      ))}

      <QuickCreateDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) setActiveType(null);
        }}
        type={activeType}
      />
    </div>
  );
}
