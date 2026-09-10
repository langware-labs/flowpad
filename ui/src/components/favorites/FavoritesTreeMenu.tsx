import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import { useFavoritesProjectRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
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
 * The tree is GLOBAL and grouped by project (`useFavoritesProjectRoots`): the
 * current project's bucket is expanded on open, every other project holding
 * favorites sits beside it as a sibling row, and hovering one enters it exactly
 * like any other folder. That structure is why the menu carries no scope
 * filter any more — "which project" is a row you hover, not a mode you set.
 *
 * Hover drives the menu; it never navigates. Clicking a leaf is still the only
 * thing that opens, but resting on one marks it seen (`onHoverSeen` →
 * `markSeen`) — the dwell is what stops a sweep from clearing every badge.
 */
export function FavoritesTreeMenu({
  mirrored,
}: {
  /** The host panel grows LEFTWARD — flip the tree's direction cues with it. */
  mirrored?: boolean;
}) {
  const { navigation, currentDock } = useDockNavigation();
  const { roots, currentBucketId, addParentFor } = useFavoritesProjectRoots();

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
        // Same dwell as the preview: seeing the tooltip IS having seen the row.
        hoverSeenMs={LEAF_TOOLTIP_MS}
        mirrored={mirrored}
        // Land in the project you're working in; the others are one hover away.
        defaultExpandedIds={[currentBucketId]}
        // Build-as-you-browse — but only where a level can actually receive a
        // row. `addParentFor` owns that question (a project list and another
        // project's desk have nowhere to put one); the tree hands the footer
        // its own mirrored axis, so this doesn't have to remember to.
        levelFooter={(levelId, treeMirrored) => {
          const parentId = addParentFor(levelId);
          return parentId === null ? null : <FavoritesAddRow parentId={parentId} mirrored={treeMirrored} />;
        }}
        // No persistKey on purpose: hover-expansion is exploratory and cheap to
        // trigger, so persisting it would restore a fully-expanded tree on every
        // open — exactly the state a hover menu exists to avoid. It would also
        // outlive `defaultExpandedIds`, pinning the menu to whatever project was
        // open the first time it was used.
        emptyState={
          <p className="text-xs text-muted-foreground">
            <Trans>No bookmarks</Trans>
          </p>
        }
      />
    </TooltipProvider>
  );
}
