import type { Bookmark } from '@sdk';
import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import { useFavoritesTreeRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import { FavoritesAddRow } from '@src/components/favorites/FavoritesAddRow';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';

/** Dwell on a folder row before it expands. Longer than the rail's open delay:
 *  running the pointer down the menu must not expand every folder it passes. */
export const HOVER_EXPAND_MS = 150;
/** Leaf preview delay. Note Radix's `skipDelayDuration` (300ms default) means
 *  this applies to the FIRST preview in a hover session — moving to a sibling
 *  row after that is instant, which is the feel a hover menu wants. */
export const LEAF_TOOLTIP_MS = 250;

/**
 * FavoritesTreeMenu — the favorites as a MENU: rows that expand on hover, for
 * fast bookmark navigation. The slider's body.
 *
 * Hover drives the menu; it never opens anything. Clicking a leaf is the only
 * thing that navigates, and so the only thing that marks a bookmark read
 * (`onOpen` → `markOpened`) — a pointer sweeping down the menu must not clear
 * every unread badge.
 */
export function FavoritesTreeMenu({
  filter,
  mirrored,
}: {
  filter?: (b: Bookmark) => boolean;
  /** The host panel grows LEFTWARD — flip the tree's direction cues with it. */
  mirrored?: boolean;
}) {
  const { navigation, currentDock } = useDockNavigation();
  const roots = useFavoritesTreeRoots({ filter });

  return (
    // Nested provider: the app-global one sets no delayDuration, so previews
    // would otherwise inherit Radix's 700ms default — far too slow for a menu
    // whose whole point is speed. Overrides here only.
    <TooltipProvider delayDuration={LEAF_TOOLTIP_MS}>
      <BrowseableTree
        roots={roots}
        activePointer={currentDock ?? null}
        onNavigate={(p) => navigation.openDock(p)}
        hoverExpandMs={HOVER_EXPAND_MS}
        mirrored={mirrored}
        // Build-as-you-browse: the last row of every level adds into THAT level.
        levelFooter={(parentId) => <FavoritesAddRow parentId={parentId} />}
        // No persistKey on purpose: hover-expansion is exploratory and cheap to
        // trigger, so persisting it would restore a fully-expanded tree on every
        // open — exactly the state a hover menu exists to avoid.
        emptyState={
          <p className="text-xs text-muted-foreground">
            <Trans>No bookmarks</Trans>
          </p>
        }
      />
    </TooltipProvider>
  );
}
