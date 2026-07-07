import { BrowseableGrid } from '@src/components/browseable-tree/BrowseableGrid';
import { useFavoritesRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Maximize2, Plus } from 'lucide-react';
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
  const [expanded, setExpanded] = useState(false);
  // ONE adapter instance feeds both the compact strip and the Launchpad
  // dialog — mutations refetch through this instance, so both stay coherent.
  const { roots, onDropToBackground, onReorderRoot } = useFavoritesRoots();

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
    <div className="relative rounded-lg border border-border bg-card/50 px-4 py-3">
      <BrowseableGrid
        roots={roots}
        activePointer={currentDock}
        leadingChrome={plusTile}
        onDropToBackground={onDropToBackground}
        onReorder={onReorderRoot}
        className="pr-6"
      />

      {/* Launchpad expand — the exact same surface, just more slots. */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={t`Expand desktop`}
        title={t`Expand desktop`}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[80vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle><Trans>Desktop</Trans></DialogTitle>
          </DialogHeader>
          <BrowseableGrid
            roots={roots}
            activePointer={currentDock}
            size="large"
            leadingChrome={plusTile}
            onDropToBackground={onDropToBackground}
            onReorder={onReorderRoot}
            className="pt-2"
          />
        </DialogContent>
      </Dialog>

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
