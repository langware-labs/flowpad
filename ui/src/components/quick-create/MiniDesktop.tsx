import { FavoriteTile } from '@src/components/favorites/FavoriteTile';
import { useFavorites } from '@src/hooks/use-favorites';
import {
  favoriteSummaryKey,
  useFavoriteSummaries,
} from '@src/hooks/use-favorite-summaries';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { QuickCreateDialog } from './QuickCreateDialog';
import { QuickCreateModal } from './QuickCreateModal';

/**
 * MiniDesktop — a desktop-grid surface on the home landing. The "+" button is
 * always first; each favorited entity renders as a tile beside it. Clicking it
 * opens the desktop-style QuickCreateModal launcher.
 */
export function MiniDesktop() {
  const [modalOpen, setModalOpen] = useState(false);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { favorites } = useFavorites();
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
        aria-label="Quick create"
        title="Create new…"
        className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="h-6 w-6" />
        <span className="text-[10px] font-medium leading-none">New</span>
      </button>

      <QuickCreateModal open={modalOpen} onOpenChange={setModalOpen} onPick={handlePick} />

      {favorites.map((fav) => {
        const type = fav.data?.entity_type;
        const id = fav.data?.entity_id;
        const summary =
          typeof type === 'string' && typeof id === 'string'
            ? summaries.get(favoriteSummaryKey(type, id))
            : undefined;
        return <FavoriteTile key={fav.id} bookmark={fav} summary={summary} />;
      })}

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
