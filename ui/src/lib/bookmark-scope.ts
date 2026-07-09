import type { Bookmark } from '@sdk';
import { projectIdInScope, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * Does a favorite/folder bookmark belong in the given scope? Thin wrapper over
 * the shared `projectIdInScope` predicate keyed on the bookmark's `project_id`.
 * Pre-existing favorites carry no `project_id`, so they surface under `all`/
 * `user` (personal) but not under a specific `project`.
 */
export function bookmarkInScope(b: Bookmark, scope: ScopeFilter, currentProjectId: string | null): boolean {
  return projectIdInScope(b.project_id ?? null, scope, currentProjectId);
}
