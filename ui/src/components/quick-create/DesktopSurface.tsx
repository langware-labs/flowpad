import type { Bookmark } from '@sdk';
import { BrowseableGrid } from '@src/components/browseable-tree/BrowseableGrid';
import { useFavoritesRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useLingui } from '@lingui/react/macro';
import { showInputPrompt } from '@src/components/ui/input-prompt-modal';
import { useFavorites } from '@src/hooks/use-favorites';
import { QuickCreateTile } from './QuickCreateTile';

/**
 * DesktopSurface — the favorites desktop as one reusable unit: a
 * BrowseableGrid over the favoritesRoot adapter (folders + favorite tiles,
 * same container protocol as the navigator trees) with the "+" quick-create
 * tile as leading chrome. Hosted full-page at /dock/desktop (DesktopPage).
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

  return (
    <BrowseableGrid
      roots={roots}
      activePointer={currentDock}
      selectedKey={selectedKey}
      size={size}
      leadingChrome={<QuickCreateTile size={size} />}
      onDropToBackground={onDropToBackground}
      backgroundActions={backgroundActions}
      onReorder={onReorderRoot}
      className={className}
    />
  );
}
