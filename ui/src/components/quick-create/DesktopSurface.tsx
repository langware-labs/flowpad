import type { Bookmark } from '@sdk';
import { BrowseableGrid } from '@src/components/browseable-tree/BrowseableGrid';
import { useFavoritesRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { showInputPrompt } from '@src/components/ui/input-prompt-modal';
import { useFavorites } from '@src/hooks/use-favorites';
import { QuickCreateModal } from './QuickCreateModal';
import { useQuickCreatePick, type PanelHandlers } from './QuickCreatePanel';

/**
 * The "+" modal when no host offers its own quick-create instance — it mounts
 * the hook (and therefore the whole dialog set) itself. Split into a component
 * so a host-supplied `panelProps` skips this subtree entirely: the dialogs are
 * not free (BindSecretDialog resolves secret origins on mount), so two
 * instances on one surface would double that work and open post-login dialogs
 * twice.
 */
function SelfHostedQuickCreateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { panelProps, dialogs } = useQuickCreatePick();
  return (
    <>
      <QuickCreateModal open={open} onOpenChange={onOpenChange} panelProps={panelProps} />
      {dialogs}
    </>
  );
}

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
  panelProps,
}: {
  size?: 'default' | 'large';
  className?: string;
  /** Optional visibility predicate (e.g. a scope filter) over favorites. */
  filter?: (b: Bookmark) => boolean;
  /** Highlight a favorite by its bookmark id (id-based selection). */
  selectedKey?: string;
  /** A host's own `useQuickCreatePick()` instance. Pass it when this surface is
   *  embedded in a page that already hosts the quick-create dialogs, so only
   *  one instance mounts; omit it and this surface hosts its own. */
  panelProps?: PanelHandlers;
}) {
  const { t } = useLingui();
  const { currentDock } = useDockNavigation();
  const [modalOpen, setModalOpen] = useState(false);
  const { roots, onDropToBackground, onReorderRoot } = useFavoritesRoots({ filter });
  const { createFolder } = useFavorites();

  // Creating a bookmark folder belongs to the desktop that holds the folders,
  // not to the "create new" launcher — same place an OS puts it, and the only
  // way to make one (the grid offers rename/move/delete but no create).
  const backgroundActions = [
    {
      id: 'new-folder',
      label: t`New folder`,
      run: () =>
        showInputPrompt({
          title: t`New bookmark folder`,
          placeholder: t`Folder name`,
          onConfirm: async (name) => {
            await createFolder(name);
          },
        }),
    },
  ];

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
        backgroundActions={backgroundActions}
        onReorder={onReorderRoot}
        className={className}
      />

      {panelProps ? (
        <QuickCreateModal open={modalOpen} onOpenChange={setModalOpen} panelProps={panelProps} />
      ) : (
        <SelfHostedQuickCreateModal open={modalOpen} onOpenChange={setModalOpen} />
      )}
    </>
  );
}
