import { useLingui } from '@lingui/react/macro';
import type { TypeId } from '@sdk';
import { AssetDiscussButton } from '@src/components/assets/editor/AssetDiscussButton';
import { EntityActionsToolbar } from '@src/components/entity-actions/EntityActionsToolbar';
import { favoriteTargetForDock } from '@src/components/favorites/favorite-target';
import { BookmarksStarButton } from './BookmarksStarButton';
import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * Bookmark / share / discuss for whatever the bar is currently addressing.
 *
 * Every one of these is an existing surface — this only picks the target and
 * mounts them. In particular the cluster is the SAME `EntityActionsToolbar` the
 * asset editor header uses, in the same order, so the actions don't drift into
 * two dialects of themselves.
 *
 * `AssetDiscussButton` is the self-gating variant on purpose: this bar is
 * global, so gating that lives inside the button (asset docks only, not already
 * in Vibe, not a popped-out window, project resolved) is exactly right. A copy
 * of those rules here would be a second copy destined to drift.
 */
export function TopBarActions({
  targetTypeId,
  targetTitle,
  dock,
}: {
  targetTypeId: TypeId | null;
  targetTitle: string;
  dock: DockPointer | null;
}) {
  const { t } = useLingui();

  // The star is rendered HERE in both branches, never by the toolbar
  // (`hideFavorite`). It has to be wrapped to carry the bookmarks menu, and the
  // toolbar's copy would be a second star sitting beside it.
  const favorite = favoriteTargetForDock(
    dock,
    targetTypeId ? { typeId: targetTypeId, entity: null } : null,
    targetTitle || t`Bookmarked view`,
  );

  if (targetTypeId) {
    return (
      <EntityActionsToolbar
        typeId={targetTypeId}
        favoriteTitle={targetTitle}
        variant="compact"
        className="shrink-0"
        // The bar owns the star (it carries the bookmarks menu), so the toolbar
        // must not draw a second one. Riding the `trailing` slot keeps it inside
        // the toolbar's own row rather than in a wrapper repeating its classes.
        hideFavorite
        trailing={
          <>
            <AssetDiscussButton />
            {favorite && <BookmarksStarButton favorite={favorite} />}
          </>
        }
      />
    );
  }

  // No entity to act on (an assets list, settings, a bare shell). The view is
  // still bookmarkable BY ITS DOCK — resolved through the same rule the
  // bookmarks menu uses, so a star set here is the row shown there. Sharing has
  // no subject, so it simply isn't offered.
  if (!favorite) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="top-nav-actions">
      <AssetDiscussButton />
      <BookmarksStarButton favorite={favorite} />
    </div>
  );
}
