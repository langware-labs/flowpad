/**
 * Unified filter state for the asset browser.
 * Lifted to AssetsPage so it persists across type-sidebar switches.
 *
 * The universal scope shape (ScopeFilter) and the URL serializer
 * (applyScopeToParams) live in @src/lib/scope-filter — they're shared with
 * the records-scanner page and any future surface that filters by user/
 * project scope.
 */
import { applyScopeToParams, scopeProjectIds, userScope, type ScopeFilter } from '@src/lib/scope-filter';

export interface AssetFilter {
  /** Free-text search query (debounced in the hook). */
  query: string;
  /** Scope restriction — single unified shape. */
  scope: ScopeFilter;
  /** Tag chips the user has added. */
  tags: string[];
  /** Per-type quick-filter key/value pairs (status, etc.). */
  filters: Record<string, string>;
  /** Folder filter: absolute parent_path. When set, list view narrows to files
   *  directly under that folder. Used by the Obsidian-style Wiki folder tree. */
  parentPath?: string;
}

export const DEFAULT_ASSET_FILTER: AssetFilter = {
  query: '',
  scope: userScope(),
  tags: [],
  filters: {},
};

/**
 * Compose ScopeFilter + AssetFilter-specific fields onto URL search params.
 * Scope serialization is delegated to applyScopeToParams so the wire format
 * stays identical across asset / scanner / search call sites.
 */
export function applyFilterToParams(params: URLSearchParams, filter: AssetFilter): void {
  applyScopeToParams(params, filter.scope);
  // When browsing a specific project, surface its records regardless of the
  // per-record ``system`` flag — system projects (e.g. @flowpad_assistant) and
  // their bootstrap-seeded docs carry ``system=True``, which the default
  // search filter hides. Being explicitly inside the project IS the opt-in,
  // mirroring DocsCategory/SkillsCategory. Global (user) browse leaves it off
  // so SDK-shipped system content stays out of the unscoped view.
  if (scopeProjectIds(filter.scope).length > 0) {
    params.set('include_system', 'true');
  }
  if (filter.tags.length > 0) {
    params.set('tags', filter.tags.join(','));
  }
  if (filter.parentPath) {
    params.set('parent_path', filter.parentPath);
  }
  for (const [k, v] of Object.entries(filter.filters)) {
    if (v) params.set(k, v);
  }
}
