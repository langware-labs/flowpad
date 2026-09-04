import { tabManager, type APIEntity, type TypeId, type AnyEntity } from '@sdk';
import type { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import type { FavoriteRef } from '@src/hooks/use-favorites';

/**
 * What "bookmark THIS screen" means — stated once, for every surface that
 * offers it.
 *
 * There are two answers and the choice matters: an entity-backed view is
 * bookmarked by its typeid, so it survives the entity being moved or renamed;
 * anything else (a web app, a shell, a lens, the app root) is bookmarked by its
 * DOCK, restored later through `openDock`. Which docks qualify is
 * `DockPointer.favoriteKey`'s answer, not one re-derived here: the root is
 * bookmarkable despite being full-bleed and therefore not a tab, and a bare
 * shell — the terminal HOST — still is not.
 *
 * This lives in one place because the two callers — the bookmarks menu's "add
 * current" row and the navigation bar's star — must agree on the ANSWER, not
 * just the question. They previously each spelled the rule out and had already
 * drifted on which id and which title they used, which meant a star lit in one
 * surface did not match the row shown in the other.
 */
export function favoriteTargetForDock(
  dock: DockPointer | null | undefined,
  entity: { typeId: TypeId | null; entity: AnyEntity | null } | null,
  fallbackTitle: string,
): FavoriteRef | null {
  if (entity?.typeId) {
    return {
      entityType: entity.typeId.type,
      entityId: entity.typeId.id,
      title: entity.entity?.displayName?.trim() || fallbackTitle,
    };
  }
  const key = dock?.favoriteKey;
  if (!dock || !key) return null;
  // The root has no tab to take a name from, and its two callers hand in
  // different fallbacks ("Home" from the breadcrumb, "Bookmarked view" from the
  // menu) — so it is named from the type registry, which is where the breadcrumb
  // got its string too. That is what keeps the star and the menu row in agreement.
  const tab = tabManager.findByDockKey(dock.tabHash);
  return {
    entityType: 'dock',
    entityId: key,
    title: tab?.name?.trim() || (dock.isRoot ? labelForType(ViewType.HOME) : '') || fallbackTitle,
    nav: { pointer: dock.toFavoriteJSON() },
  };
}
