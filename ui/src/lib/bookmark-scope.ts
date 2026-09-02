import { AUTO_BOOKMARK_SOURCE, type Bookmark } from '@sdk';
import { isAllScope, projectIdInScope, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * Does a favorite/folder bookmark belong in the given scope?
 *
 * An UNSCOPED bookmark (no `project_id`) is personal/global and belongs in
 * EVERY scope, including a specific project — favorites are a cross-project
 * desktop, not project content. This deliberately departs from the generic
 * `projectIdInScope`, whose "no project ⇒ user-scope only" rule would hide
 * every favorite created before `project_id` stamping existed (i.e. all of
 * them, on any pre-existing install) the moment a project is active — and
 * `defaultScopeFilter` makes project scope the default whenever one is. That
 * is what left the bookmarks slider rendering an empty desktop.
 *
 * The `flow show` AUTO tree is the one exception, and it is not personal: it
 * is machine-built, and `mint_auto_favorite` keys its find-or-create on
 * `project_id`, so each project gets a root of its OWN. Reading an unscoped
 * auto row as global therefore disagreed with the writer — a tree written
 * before stamping existed stayed visible in every project, next to the root
 * that project had since minted for itself, and the favorites desktop showed
 * two folders both called "Auto". Auto rows scope like the content they are.
 *
 * A bookmark that DOES carry a `project_id` still filters normally, so a
 * project-stamped favorite stays out of an unrelated project's scope.
 */
export function bookmarkInScope(b: Bookmark, scope: ScopeFilter, currentProjectId: string | null): boolean {
  if (!b.project_id && b.source !== AUTO_BOOKMARK_SOURCE) return true;
  return projectIdInScope(b.project_id, scope, currentProjectId);
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
