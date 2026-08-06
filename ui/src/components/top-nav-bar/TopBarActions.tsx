import { useLingui } from '@lingui/react/macro';
import type { TypeId } from '@sdk';
import { AssetDiscussButton } from '@src/components/assets/editor/AssetDiscussButton';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { EntityActionsToolbar } from '@src/components/entity-actions/EntityActionsToolbar';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { favoriteTargetForDock } from '@src/components/favorites/favorite-target';
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

  if (targetTypeId) {
    return (
      <EntityActionsToolbar
        typeId={targetTypeId}
        favoriteTitle={targetTitle}
        variant="compact"
        trailing={<AssetDiscussButton />}
        className="shrink-0"
      />
    );
  }

  // No entity to act on (an assets list, settings, a bare shell). The view is
  // still bookmarkable BY ITS DOCK — resolved through the same rule the
  // bookmarks menu uses, so a star set here is the row shown there. Sharing has
  // no subject, so it simply isn't offered.
  const favorite = favoriteTargetForDock(dock, null, targetTitle || t`Bookmarked view`);
  if (!favorite) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="top-nav-actions">
      <FavoriteStar
        entityType={favorite.entityType}
        entityId={favorite.entityId}
        title={favorite.title}
        nav={favorite.nav}
        size={14}
        className={`${compactEntityActionClassName} p-0`}
      />
      <AssetDiscussButton />
    </div>
  );
}
