import type { Bookmark } from '@sdk';
import { BrowseableGrid } from '@src/components/browseable-tree/BrowseableGrid';
import { useFavoritesRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import { useProject } from '@sdk/react/hooks';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { QuickCreateDialog } from './QuickCreateDialog';
import { QuickCreateModal } from './QuickCreateModal';
import { getDescriptor } from './registry';

/**
 * DesktopSurface — the favorites desktop as one reusable unit: a
 * BrowseableGrid over the favoritesRoot adapter (folders + favorite tiles,
 * same container protocol as the navigator trees) with the "+" quick-create
 * tile as leading chrome. Hosted compact on the home landing (MiniDesktop)
 * and full-page at /dock/desktop (DesktopPage) — same surface, more slots.
 */
export function DesktopSurface({
  size = 'default',
  className,
  filter,
  selectedKey,
}: {
  size?: 'default' | 'large';
  className?: string;
  /** Optional visibility predicate (e.g. a scope filter) over favorites. */
  filter?: (b: Bookmark) => boolean;
  /** Highlight a favorite by its bookmark id (id-based selection). */
  selectedKey?: string;
}) {
  const { t } = useLingui();
  const { currentDock } = useDockNavigation();
  const { project } = useProject();
  const [modalOpen, setModalOpen] = useState(false);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { roots, onDropToBackground, onReorderRoot } = useFavoritesRoots({ filter });
  // A type whose on-disk location is already fixed by TypeInfo brings its own
  // dialog — the generic name+path form would only ask it questions it can't
  // answer. Chosen here, not inside QuickCreateDialog, so the generic form's
  // project fetch + snapshot never run for a type that discards them.
  const CustomDialog = activeType ? getDescriptor(activeType)?.Dialog : undefined;

  const handlePick = (type: string) => {
    setActiveType(type);
    setDialogOpen(true);
  };

  const handleDialogChange = (next: boolean) => {
    setDialogOpen(next);
    if (!next) setActiveType(null);
  };

  const tileSize = size === 'large' ? 'h-20 w-20' : 'h-16 w-16';
  const plusTile = (
    <button
      type="button"
      onClick={() => setModalOpen(true)}
      aria-label={t`Quick create`}
      title={t`Create new…`}
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        tileSize,
      )}
    >
      <Plus className="h-6 w-6" />
      <span className="text-[10px] font-medium leading-none"><Trans>New</Trans></span>
    </button>
  );

  return (
    <>
      <BrowseableGrid
        roots={roots}
        activePointer={currentDock}
        selectedKey={selectedKey}
        size={size}
        leadingChrome={plusTile}
        onDropToBackground={onDropToBackground}
        onReorder={onReorderRoot}
        className={className}
      />

      <QuickCreateModal open={modalOpen} onOpenChange={setModalOpen} onPick={handlePick} />
      {CustomDialog ? (
        <CustomDialog open={dialogOpen} onOpenChange={handleDialogChange} projectId={project?.id ?? null} />
      ) : (
        <QuickCreateDialog open={dialogOpen} onOpenChange={handleDialogChange} type={activeType} />
      )}
    </>
  );
}
