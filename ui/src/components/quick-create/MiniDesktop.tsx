import { BrowseableGrid } from '@src/components/browseable-tree/BrowseableGrid';
import { useFavoritesRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { QuickCreateDialog } from './QuickCreateDialog';
import { QuickCreateModal } from './QuickCreateModal';

/**
 * MiniDesktop — the desktop-grid surface on the home landing: a
 * BrowseableGrid over the favoritesRoot adapter (folders + favorite tiles,
 * same container protocol as the navigator trees), with the "+" quick-create
 * tile as leading chrome. Clicking "+" opens the desktop-style
 * QuickCreateModal launcher.
 */
export function MiniDesktop() {
  const { t } = useLingui();
  const { currentDock } = useDockNavigation();
  const [modalOpen, setModalOpen] = useState(false);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { roots, onDropToBackground } = useFavoritesRoots();

  const handlePick = (type: string) => {
    setActiveType(type);
    setDialogOpen(true);
  };

  const plusTile = (
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
  );

  return (
    <div className="rounded-lg border border-border bg-card/50 px-4 py-3">
      <BrowseableGrid
        roots={roots}
        activePointer={currentDock}
        leadingChrome={plusTile}
        onDropToBackground={onDropToBackground}
      />

      <QuickCreateModal open={modalOpen} onOpenChange={setModalOpen} onPick={handlePick} />
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
