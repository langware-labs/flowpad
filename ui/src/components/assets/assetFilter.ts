/**
 * Unified filter state for the asset browser.
 * Lifted to AssetsPage so it persists across type-sidebar switches.
 *
 * The universal scope shape (ScopeFilter) and the URL serializer
 * (applyScopeToParams) live in @src/lib/scope-filter — they're shared with
 * the records-scanner page and any future surface that filters by user/
 * project scope.
 */
import { applyScopeToParams, type ScopeFilter } from '@src/lib/scope-filter';

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
  scope: { user: true, projects: [] },
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
