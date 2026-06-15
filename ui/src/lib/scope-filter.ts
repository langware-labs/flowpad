/**
 * Single source of truth for "which records does the user want to see".
 * Every UI surface (assets browser, records scanner, search bar) and every
 * API call ships this exact shape.
 *
 *  - `all`      — show everything (user + every project + unscoped types).
 *                 When set, `user`/`projects` are ignored and NO scope params
 *                 are sent, so the backend applies no scope filter at all.
 *  - `user`     — include user-scope records (~/.claude/...).
 *  - `projects` — entity-IDs of projects to include; empty array = no projects.
 *
 * The single-select scope UI (All / User / Project / Selected) is a
 * presentational view over this shape — see useScopeFilterChips for the
 * mode→ScopeFilter mapping. The legal states:
 *   {all: true}                                — everything (no scope filter)
 *   {user: true,  projects: []}                — user only
 *   {user: false, projects: [currentId]}       — current project only
 *   {user: false, projects: [...]}             — selected projects only
 *   {user: false, projects: []}                — nothing (degenerate; UI guards)
 */
export interface ScopeFilter {
  user: boolean;
  projects: string[];
  /** Everything — no scope filter applied. Overrides user/projects. */
  all?: boolean;
}

export const EMPTY_SCOPE_FILTER: ScopeFilter = { user: true, projects: [] };

/** Show everything — the backend receives no scope params. */
export const ALL_SCOPE_FILTER: ScopeFilter = { user: true, projects: [], all: true };

/**
 * The default a user-facing surface should land on. When a current project
 * is in context, default to the Project chip (project only, no user scope)
 * so scan/index/list operations start narrowest. Pass `null`/`undefined`
 * for project-less surfaces — falls through to EMPTY_SCOPE_FILTER (user-only).
 *
 * Centralized here so no consumer has to re-implement "seed from
 * currentProjectId" — every UI that holds a ScopeFilter starts from this.
 */
export function defaultScopeFilter(currentProjectId?: string | null): ScopeFilter {
  if (!currentProjectId) return { ...EMPTY_SCOPE_FILTER };
  return { user: false, projects: [currentProjectId] };
}

/** Equality on ScopeFilter (order-insensitive on `projects`). */
export function scopeFilterEqual(a: ScopeFilter, b: ScopeFilter): boolean {
  if (!!a.all !== !!b.all) return false;
  if (a.all) return true; // user/projects are ignored when `all`
  if (a.user !== b.user) return false;
  if (a.projects.length !== b.projects.length) return false;
  const ap = [...a.projects].sort();
  const bp = [...b.projects].sort();
  return ap.every((v, i) => v === bp[i]);
}

/**
 * Scopes that are matched by `project_id` (carry a project). Mirrors the
 * backend `PROJECT_LIKE_SCOPES` (flow_sdk/server/search_filters.py) — keep in
 * sync. System rows carry the system project's id, so they're surfaced by
 * selecting that project, exactly like ordinary project rows.
 */
export const PROJECT_LIKE_SCOPES = ['project', 'system'] as const;

/**
 * The scope "bucket" an opened asset belongs to: its project (project- or
 * system-scoped) or the user scope. Derived from the asset's `scope`/
 * `project_id`; `null` when the asset has no resolvable bucket.
 */
export type AssetScopeBucket = { projectId: string } | { user: true } | null;

/**
 * Resolve an asset's scope bucket from its `scope`/`project_id` fields. Used to
 * union the open asset's own scope into a side-menu filter (see
 * `unionAssetBucket`). Returns `null` when the asset has no resolvable bucket.
 */
export function assetScopeBucket(
  asset: { scope?: string | null; project_id?: string | null } | null | undefined,
): AssetScopeBucket {
  const scope = asset?.scope ?? '';
  const projectId = asset?.project_id ?? null;
  if (scope === 'user') return { user: true };
  if (projectId && (PROJECT_LIKE_SCOPES as readonly string[]).includes(scope)) {
    return { projectId };
  }
  return null;
}

/**
 * Union an opened asset's bucket onto a base ScopeFilter so the asset's own
 * type/count shows up in the side menu while you're viewing it. Returns the
 * base unchanged (same reference) when there's nothing to add — when `all` is
 * set (already shows everything), the bucket is empty, or the bucket is already
 * represented. Recompute per open; do not accumulate buckets across opens.
 */
export function unionAssetBucket(base: ScopeFilter, bucket: AssetScopeBucket): ScopeFilter {
  if (!bucket || base.all) return base;
  if ('user' in bucket) {
    return base.user ? base : { ...base, user: true };
  }
  if (base.projects.includes(bucket.projectId)) return base;
  return { ...base, projects: [...base.projects, bucket.projectId] };
}

/** Stable key for React-Query and cache invalidation. */
export function scopeFilterKey(sf: ScopeFilter): string {
  if (sf.all) return 'all';
  return `${sf.user ? '1' : '0'}:${[...sf.projects].sort().join(',')}`;
}

/**
 * Serialize a ScopeFilter onto URL search params: `?user=true&projects=A,B`.
 *
 * Both keys are always written (no implicit "no filter" — that's
 * represented by `{user: true, projects: []}` which the backend interprets
 * as "user-scoped + unscoped record types, no projects"). Empty
 * `projects` is sent as the empty string so the backend can distinguish
 * "filter present but empty" from "no filter".
 */
export function applyScopeToParams(params: URLSearchParams, scope: ScopeFilter): void {
  // "All" = everything: send no scope params so the backend applies no filter.
  if (scope.all) return;
  params.set('user', scope.user ? 'true' : 'false');
  params.set('projects', scope.projects.join(','));
}

/** Build a `?user=…&projects=…` query string from a ScopeFilter. */
export function scopeToQueryString(scope: ScopeFilter): string {
  const p = new URLSearchParams();
  applyScopeToParams(p, scope);
  return p.toString();
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
