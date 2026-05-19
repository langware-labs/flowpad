/**
 * Unified filter state for the asset browser.
 * Lifted to AssetsPage so it persists across type-sidebar switches.
 */

/**
 * Single source of truth for "which records does the user want to see".
 * Every UI surface and every API call ships this exact shape.
 *
 *  - `user`     — include user-scope records (~/.claude/...).
 *  - `projects` — entity-IDs of projects to include; empty array = no projects.
 *
 * No sentinels, no string unions. The four legal states:
 *   {user: true,  projects: []}                — user only
 *   {user: true,  projects: [...]}             — user + listed projects
 *   {user: false, projects: [...]}             — listed projects only
 *   {user: false, projects: []}                — nothing (degenerate; UI guards)
 *
 * The 3-chip UI (User / Project / Both) is a presentational view over this
 * shape — see ScopeFilterBar for the chip→ScopeFilter mapping.
 */
export interface ScopeFilter {
  user: boolean;
  projects: string[];
}

export const EMPTY_SCOPE_FILTER: ScopeFilter = { user: true, projects: [] };

/** Equality on ScopeFilter (order-insensitive on `projects`). */
export function scopeFilterEqual(a: ScopeFilter, b: ScopeFilter): boolean {
  if (a.user !== b.user) return false;
  if (a.projects.length !== b.projects.length) return false;
  const ap = [...a.projects].sort();
  const bp = [...b.projects].sort();
  return ap.every((v, i) => v === bp[i]);
}

/** Stable key for React-Query and cache invalidation. */
export function scopeFilterKey(sf: ScopeFilter): string {
  return `${sf.user ? '1' : '0'}:${[...sf.projects].sort().join(',')}`;
}

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
 * Serialize a ScopeFilter to URL search params: `?user=true&projects=A,B`.
 *
 * Both keys are always written (no implicit "no filter" — that's
 * represented by `{user: true, projects: []}` which the backend interprets
 * as "user-scoped + unscoped record types, no projects"). Empty
 * `projects` is sent as the empty string so the backend can distinguish
 * "filter present but empty" from "no filter".
 */
export function applyFilterToParams(params: URLSearchParams, filter: AssetFilter): void {
  params.set('user', filter.scope.user ? 'true' : 'false');
  params.set('projects', filter.scope.projects.join(','));
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

/** Parse a `?user=&projects=` query-string back into a ScopeFilter.
 *  Used by tests and by any URL-driven UI that wants to round-trip. */
export function parseScopeFilterFromParams(params: URLSearchParams): ScopeFilter {
  const userRaw = (params.get('user') ?? 'true').toLowerCase();
  const projectsRaw = params.get('projects') ?? '';
  return {
    user: userRaw === 'true' || userRaw === '1',
    projects: projectsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  };
}
