/**
 * Single source of truth for "which records does the user want to see".
 * Every UI surface (assets browser, records scanner, search bar) and every
 * API call ships this exact shape.
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

/**
 * The default a user-facing surface should land on when there's a current
 * project in context: include user + the current project, so the "Project"
 * chip count is meaningful from the first render. Pass `null`/`undefined`
 * for surfaces without a project context — falls through to EMPTY_SCOPE_FILTER.
 *
 * Centralized here so no consumer has to re-implement "seed from
 * currentProjectId" — every UI that holds a ScopeFilter starts from this.
 */
export function defaultScopeFilter(currentProjectId?: string | null): ScopeFilter {
  if (!currentProjectId) return { ...EMPTY_SCOPE_FILTER };
  return { user: true, projects: [currentProjectId] };
}

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
