import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import { FavoritesAddRow } from '@src/components/favorites/FavoritesAddRow';
import { FavoritesBreadcrumb } from '@src/components/favorites/FavoritesBreadcrumb';
import { useFavoritesLevel } from '@src/components/favorites/use-favorites-level';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { createPortal } from 'react-dom';

/** Leaf preview delay. Note Radix's `skipDelayDuration` (300ms default) means
 *  this applies to the FIRST preview in a hover session — moving to a sibling
 *  row after that is instant, which is the feel a hover menu wants. */
export const LEAF_TOOLTIP_MS = 250;

/**
 * FavoritesTreeMenu — the favorites as a MENU, one level at a time: the rows of
 * the level its breadcrumb names. The bookmarks panel's body.
 *
 * It opens at the open project (`useFavoritesLevel`); a project or folder row
 * is entered by click and the breadcrumb goes back up. Clicking a leaf is the
 * only thing that navigates; resting on one marks it seen (`onHoverSeen` →
 * `markSeen`) — the dwell is what stops a sweep from clearing every badge.
 *
 * The breadcrumb is drawn into `breadcrumbSlot`, the host panel's header: the
 * level lives HERE, in the part of the panel that unmounts when it closes, so
 * every open starts at the open project again and a closed panel runs none of
 * the favorites queries.
 */
export function FavoritesTreeMenu({ breadcrumbSlot }: { breadcrumbSlot: HTMLElement | null }) {
  const { navigation, currentDock } = useDockNavigation();
  const { crumbs, rows, addParentId, goTo } = useFavoritesLevel();

  return (
    // Nested provider: the app-global one sets no delayDuration, so previews
    // would otherwise inherit Radix's 700ms default — far too slow for a menu
    // whose whole point is speed. Overrides here only.
    <TooltipProvider delayDuration={LEAF_TOOLTIP_MS}>
      {breadcrumbSlot && createPortal(<FavoritesBreadcrumb crumbs={crumbs} goTo={goTo} />, breadcrumbSlot)}
      {/* Build-as-you-browse: the level's own add row, where the level can take one. */}
      {addParentId !== null && (
        <div className="px-1 pt-1">
          <FavoritesAddRow parentId={addParentId} />
        </div>
      )}
      <BrowseableTree
        roots={rows}
        activePointer={currentDock ?? null}
        onNavigate={(p) => navigation.openDock(p)}
        // Same dwell as the preview: seeing the tooltip IS having seen the row.
        hoverSeenMs={LEAF_TOOLTIP_MS}
        // The panel hangs off the window's inline-end edge.
        previewSide="start"
        // One level, nothing expands: the rows start on the same edge as the
        // add row and the Notes below.
        flat
        emptyState={
          <p className="text-xs text-muted-foreground">
            <Trans>No bookmarks yet</Trans>
          </p>
        }
      />
    </TooltipProvider>
  );
}
