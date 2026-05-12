/**
 * Unified filter state for the asset browser.
 * Lifted to AssetsPage so it persists across type-sidebar switches.
 */
export type AssetScope = 'all' | 'user' | 'project';

export interface AssetFilter {
  /** Free-text search query (debounced in the hook). */
  query: string;
  /**
   * Scope restriction.
   * - 'all'     = union of user-scoped + project-scoped (filtered by `projectIds`).
   *               When `projectIds` is empty, falls back to user-only.
   * - 'user'    = user-scoped only; `projectIds` is ignored.
   * - 'project' = project-scoped only, restricted to `projectIds`.
   * The project filter (which projects) is set independently via the funnel
   * filter button, not by clicking the scope buttons.
   */
  scope: AssetScope;
  /** Project entity IDs the project-half of the filter applies to. Used by
   *  scope='all' (user + these projects) and scope='project' (these projects only). */
  projectIds: string[];
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
  scope: 'all',
  projectIds: [],
  tags: [],
  filters: {},
};

/**
 * Serialize scope fields to URLSearchParams entries.
 *
 * - scope='all'     + projectIds non-empty -> scope=user,project & project_ids=…
 * - scope='all'     + projectIds empty     -> scope=user (no current project fallback)
 * - scope='user'                            -> scope=user
 * - scope='project'                         -> scope=project & project_ids=…
 */
export function applyFilterToParams(params: URLSearchParams, filter: AssetFilter): void {
  if (filter.scope === 'all') {
    if (filter.projectIds.length > 0) {
      params.set('scope', 'user,project');
      params.set('project_ids', filter.projectIds.join(','));
    }
    // ``all`` with no project filter intentionally omits ``scope`` so
    // unscoped record types (e.g. ``project``) still appear; the previous
    // ``scope=user`` fallback hid every project from /dock/assets/list/project.
  } else if (filter.scope === 'user') {
    params.set('scope', 'user');
  } else if (filter.scope === 'project') {
    params.set('scope', 'project');
    if (filter.projectIds.length > 0) {
      params.set('project_ids', filter.projectIds.join(','));
    }
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
