/**
 * Unified filter state for the asset browser.
 * Lifted to AssetsPage so it persists across type-sidebar switches.
 */
export type AssetScope = 'all' | 'user' | 'project';

export interface AssetFilter {
  /** Free-text search query (debounced in the hook). */
  query: string;
  /** Scope restriction. 'all' = no filter, 'user' = user-scoped, 'project' = specific projects. */
  scope: AssetScope;
  /** When scope='project', the list of project entity IDs to include. Ignored otherwise. */
  projectIds: string[];
  /** Tag chips the user has added. */
  tags: string[];
  /** Per-type quick-filter key/value pairs (status, etc.). */
  filters: Record<string, string>;
  /** Folder filter: absolute parent_path. When set, list view narrows to files
   *  directly under that folder. Used by the Obsidian-style Wiki folder tree. */
  parentPath?: string;
  /** Include SDK-shipped system-project entities. Off by default — the wiki
   *  normally hides them unless the user flips the "Show system" checkbox. */
  includeSystem?: boolean;
}

export const DEFAULT_ASSET_FILTER: AssetFilter = {
  query: '',
  scope: 'all',
  projectIds: [],
  tags: [],
  filters: {},
  includeSystem: false,
};

/**
 * Serialize scope fields to URLSearchParams entries.
 *
 * - scope='all'     -> (no params)
 * - scope='user'    -> scope=user
 * - scope='project' -> scope=project&project_ids=id1,id2
 */
export function applyFilterToParams(params: URLSearchParams, filter: AssetFilter): void {
  if (filter.scope !== 'all') {
    params.set('scope', filter.scope);
  }
  if (filter.scope === 'project' && filter.projectIds.length > 0) {
    params.set('project_ids', filter.projectIds.join(','));
  }
  if (filter.tags.length > 0) {
    params.set('tags', filter.tags.join(','));
  }
  if (filter.parentPath) {
    params.set('parent_path', filter.parentPath);
  }
  if (filter.includeSystem) {
    params.set('include_system', 'true');
  }
  for (const [k, v] of Object.entries(filter.filters)) {
    if (v) params.set(k, v);
  }
}
