import type { APIEntity, TypeId } from '@sdk';
import type { DockPointer } from '@src/navigation/DockPointer';
import { getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import type { FavoriteRef } from '@src/hooks/use-favorites';

/**
 * What "bookmark THIS screen" means — stated once, for every surface that
 * offers it.
 *
 * There are two answers and the choice matters: an entity-backed view is
 * bookmarked by its typeid, so it survives the entity being moved or renamed;
 * anything else (a web app, a shell, a lens) is bookmarked by its DOCK, restored
 * later through `openDock`. Only a full-bleed surface with no tab identity has
 * nothing to bookmark at all.
 *
 * This lives in one place because the two callers — the bookmarks menu's "add
 * current" row and the navigation bar's star — must agree on the ANSWER, not
 * just the question. They previously each spelled the rule out and had already
 * drifted on which id and which title they used, which meant a star lit in one
 * surface did not match the row shown in the other.
 */
export function favoriteTargetForDock(
  dock: DockPointer | null | undefined,
  entity: { typeId: TypeId | null; entity: APIEntity<any> | null } | null,
  fallbackTitle: string,
): FavoriteRef | null {
  if (entity?.typeId) {
    return {
      entityType: entity.typeId.type,
      entityId: entity.typeId.id,
      title: entity.entity?.displayName?.trim() || fallbackTitle,
    };
  }
  if (!dock?.tabHash) return null;
  const tab = getAllTabsSnapshot().find((t) => t.getKey() === dock.tabHash);
  return {
    entityType: 'dock',
    entityId: dock.tabHash,
    title: tab?.name?.trim() || fallbackTitle,
    nav: { pointer: dock.toJSON() },
  };
}
