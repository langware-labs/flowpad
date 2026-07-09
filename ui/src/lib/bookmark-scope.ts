import type { Bookmark } from '@sdk';
import { isAllScope, projectIdInScope, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * Does a favorite/folder bookmark belong in the given scope? Thin wrapper over
 * the shared `projectIdInScope` predicate keyed on the bookmark's `project_id`.
 * Pre-existing favorites carry no `project_id`, so they surface under `all`/
 * `user` (personal) but not under a specific `project`.
 */
export function bookmarkInScope(b: Bookmark, scope: ScopeFilter, currentProjectId: string | null): boolean {
  return projectIdInScope(b.project_id ?? null, scope, currentProjectId);
}

/**
 * A favorites-desktop visibility predicate for a scope, or `undefined` when the
 * scope is "show everything" (null/`all`) so the caller can pass no filter. The
 * single owner of "turn a ScopeFilter into a favorites filter" — shared by the
 * MiniDesktop and the full DesktopPage so they never drift. A `project` scope
 * already carries its `activeProjectId`, so no `currentProjectId` anchor needed.
 */
export function favoritesFilterForScope(
  scope: ScopeFilter | null | undefined,
): ((b: Bookmark) => boolean) | undefined {
  if (!scope || isAllScope(scope)) return undefined;
  return (b) => bookmarkInScope(b, scope, null);
}
